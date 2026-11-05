package connector

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fingerprintOperator is an operator socket that serves only the inventory
// fingerprint, answering `status` (200 with the current value, or 404 for an
// operator that predates the route).
type fingerprintOperator struct {
	mu          sync.Mutex
	fingerprint string
	status      int
}

func (o *fingerprintOperator) set(fingerprint string) {
	o.mu.Lock()
	o.fingerprint = fingerprint
	o.mu.Unlock()
}

func startFingerprintOperator(t *testing.T, status int) (*fingerprintOperator, string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "op")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "operator.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	op := &fingerprintOperator{fingerprint: "fp-1", status: status}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/capabilities" {
			_, _ = w.Write([]byte(`{"features":["provider_management","provider_usage"]}`))
			return
		}
		if r.URL.Path != "/inventory/fingerprint" || op.status != http.StatusOK {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"no route"}}`))
			return
		}
		op.mu.Lock()
		fingerprint := op.fingerprint
		op.mu.Unlock()
		_, _ = w.Write([]byte(`{"fingerprint":"` + fingerprint + `"}`))
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return op, socket
}

func watchingClient(t *testing.T, broker *fakeBroker, socket string) *Client {
	t.Helper()
	gw, _ := fakeGateway(t)
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	c.OperatorSocket = socket
	c.InventoryPollInterval = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	return c
}

func linkContext(accepts ...string) Text {
	return Text{T: TLinkContext, Environment: "dev", Openedbot: "http://localhost:1420", Accepts: accepts}
}

// nextInventoryChanged waits for an inventory.changed frame, skipping the
// other unsolicited frames a session may send.
func nextInventoryChanged(t *testing.T, broker *fakeBroker, within time.Duration) bool {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case f := <-broker.frames:
			if f.T == TInventoryChanged {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

func TestInventoryWatchSignalsAtStartThenOnlyWhenTheFingerprintMoves(t *testing.T) {
	broker := newBroker(t)
	op, socket := startFingerprintOperator(t, http.StatusOK)
	watchingClient(t, broker, socket)
	broker.send(linkContext(TInventoryChanged))

	// What changed while the link was down is unknown: one signal at start.
	if !nextInventoryChanged(t, broker, 2*time.Second) {
		t.Fatal("no inventory.changed at the start of the session")
	}
	// Several polls on the same fingerprint: silence.
	if nextInventoryChanged(t, broker, 200*time.Millisecond) {
		t.Fatal("inventory.changed sent while the fingerprint did not move")
	}
	op.set("fp-2")
	if !nextInventoryChanged(t, broker, 2*time.Second) {
		t.Fatal("no inventory.changed after the fingerprint moved")
	}
}

// An openedbot that does not list the frame in link.context closes the link
// on an unknown frame type: it must never receive one.
func TestInventoryWatchStaysSilentForAnOpenedbotThatDoesNotAcceptIt(t *testing.T) {
	broker := newBroker(t)
	op, socket := startFingerprintOperator(t, http.StatusOK)
	watchingClient(t, broker, socket)
	broker.send(linkContext())
	op.set("fp-2")
	if nextInventoryChanged(t, broker, 300*time.Millisecond) {
		t.Fatal("inventory.changed sent to an openedbot that did not accept it")
	}
}

// An operator that predates the route answers 404: the watch stops, and
// openedbot, which never hears from it, keeps bounding its snapshot's age.
func TestInventoryWatchStopsOnAnOperatorWithoutTheRoute(t *testing.T) {
	broker := newBroker(t)
	_, socket := startFingerprintOperator(t, http.StatusNotFound)
	watchingClient(t, broker, socket)
	broker.send(linkContext(TInventoryChanged))
	if nextInventoryChanged(t, broker, 300*time.Millisecond) {
		t.Fatal("inventory.changed sent by a host that cannot watch")
	}
}

func TestLinkContextAcceptsIsBoundedAndValidated(t *testing.T) {
	ok, _ := EncodeText(linkContext(TInventoryChanged))
	if f, err := DecodeText(ok); err != nil || !acceptsInventoryChanged(f) {
		t.Fatalf("%v %+v", err, f)
	}
	bad, _ := EncodeText(linkContext("Not A Frame"))
	if _, err := DecodeText(bad); err == nil {
		t.Fatal("accepted a frame type outside the grammar")
	}
	many := make([]string, MaxLinkContextAccepts+1)
	for i := range many {
		many[i] = "x.frame"
	}
	tooMany, _ := EncodeText(linkContext(many...))
	if _, err := DecodeText(tooMany); err == nil {
		t.Fatal("accepted more frame types than the bound")
	}
	// The host signal itself carries nothing and decodes as such.
	signal, _ := EncodeText(Text{T: TInventoryChanged})
	if f, err := DecodeText(signal); err != nil || f.T != TInventoryChanged {
		t.Fatalf("%v %+v", err, f)
	}
}
