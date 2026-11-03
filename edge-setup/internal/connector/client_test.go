package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeBroker is the openedbot side, scripted by the test.
type fakeBroker struct {
	t       *testing.T
	srv     *httptest.Server
	mu      sync.Mutex
	conn    *websocket.Conn
	authHdr string
	hello   Text
	frames  chan Text
	chunks  chan []byte
	ready   chan struct{}
	sent    [][]byte
}

func newBroker(t *testing.T) *fakeBroker {
	b := &fakeBroker{t: t, frames: make(chan Text, 100), chunks: make(chan []byte, 1000), ready: make(chan struct{})}
	b.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.authHdr = r.Header.Get("Authorization")
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-connector.v1"}})
		if err != nil {
			return
		}
		c.SetReadLimit(MaxResponseBody + 4)
		b.mu.Lock()
		b.conn = c
		b.mu.Unlock()
		kind, data, err := c.Read(context.Background())
		if err != nil || kind != websocket.MessageText {
			return
		}
		b.hello, _ = DecodeText(data)
		close(b.ready)
		for {
			kind, data, err := c.Read(context.Background())
			if err != nil {
				return
			}
			if kind == websocket.MessageBinary {
				b.chunks <- data
				continue
			}
			f, _ := DecodeText(data)
			b.frames <- f
		}
	}))
	t.Cleanup(b.srv.Close)
	return b
}

func (b *fakeBroker) send(t Text) {
	b.mu.Lock()
	c := b.conn
	b.mu.Unlock()
	data, _ := EncodeText(t)
	b.sent = append(b.sent, data)
	if err := c.Write(context.Background(), websocket.MessageText, data); err != nil {
		b.t.Fatal(err)
	}
}

func (b *fakeBroker) sendBinary(id uint32, chunk []byte) {
	b.mu.Lock()
	c := b.conn
	b.mu.Unlock()
	data := EncodeBinary(id, chunk)
	b.sent = append(b.sent, data)
	_ = c.Write(context.Background(), websocket.MessageBinary, data)
}

func (b *fakeBroker) wsURL() string { return "ws" + strings.TrimPrefix(b.srv.URL, "http") }

func (b *fakeBroker) next(t *testing.T) Text {
	t.Helper()
	select {
	case f := <-b.frames:
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("no frame")
	}
	return Text{}
}

func (b *fakeBroker) body(t *testing.T, id uint32) string {
	t.Helper()
	var out strings.Builder
	for {
		select {
		case c := <-b.chunks:
			gid, chunk, _ := DecodeBinary(c)
			if gid == id {
				out.Write(chunk)
			}
		case f := <-b.frames:
			if f.T == TEnd && f.ID == id {
				// The reader queues a chunk before the end frame that follows
				// it, but select picks either ready channel: drain what is
				// already buffered before closing the body.
				for {
					select {
					case c := <-b.chunks:
						if gid, chunk, _ := DecodeBinary(c); gid == id {
							out.Write(chunk)
						}
						continue
					default:
					}
					break
				}
				return out.String()
			}
			if f.T == TErr && f.ID == id {
				t.Fatalf("err frame: %+v", f)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("body not terminated")
		}
	}
}

const bearer = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// fakeGateway is the loopback Hermes api_server.
func fakeGateway(t *testing.T) (*httptest.Server, *[]string) {
	var seen []string
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.String()+" auth="+r.Header.Get("Authorization")+" cookie="+r.Header.Get("Cookie"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+bearer {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.URL.Path == "/health":
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.URL.Path == "/v1/runs" && r.Method == "POST":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"run_id":"run_42","status":"queued"}`))
		case r.URL.Path == "/v1/runs/run_42/events":
			w.Header().Set("Content-Type", "text/event-stream")
			fl := w.(http.Flusher)
			for i := 1; i <= 3; i++ {
				_, _ = w.Write([]byte("event: run.delta\ndata: {\"n\":" + string(rune('0'+i)) + "}\n\n"))
				fl.Flush()
				time.Sleep(10 * time.Millisecond)
			}
			_, _ = w.Write([]byte("event: run.completed\ndata: {}\n\n"))
			fl.Flush()
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func TestClientServesAllowlistedRequestsWithLocalBearer(t *testing.T) {
	broker := newBroker(t)
	gw, seen := fakeGateway(t)
	j, _ := NewJournal(t.TempDir())
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, j)
	c.HTTP = gw.Client()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	if broker.authHdr != "Bearer link:rt-1.tok" || broker.hello.T != THello || broker.hello.Protocol != 1 {
		t.Fatalf("auth=%q hello=%+v", broker.authHdr, broker.hello)
	}
	// 1. Allowed GET with a Cookie header that must be stripped.
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Headers: map[string]string{"accept": "application/json", "cookie": "evil=1", "authorization": "Bearer attacker"}, Body: "none"})
	res := broker.next(t)
	if res.T != TRes || res.Status != 200 {
		t.Fatalf("%+v", res)
	}
	if body := broker.body(t, 1); body != `{"ok":true}` {
		t.Fatalf("body %q", body)
	}
	// 2. Forbidden route never touches the gateway.
	broker.send(Text{T: TReq, ID: 2, Method: "DELETE", Path: "/api/credentials/pool", Body: "none"})
	if e := broker.next(t); e.T != TErr || e.Code != "HERMES_LINK_PATH_FORBIDDEN" || e.Stage != StageBeforeDispatch {
		t.Fatalf("%+v", e)
	}
	// 3. POST with a streamed body → run created, then replay from the journal.
	broker.send(Text{T: TReq, ID: 3, Method: "POST", Path: "/v1/runs", Headers: map[string]string{"content-type": "application/json"}, Body: "stream"})
	broker.sendBinary(3, []byte(`{"input":"hi"}`))
	broker.send(Text{T: TEnd, ID: 3})
	if r := broker.next(t); r.T != TRes || r.Status != 201 {
		t.Fatalf("%+v", r)
	}
	if body := broker.body(t, 3); !strings.Contains(body, "run_42") {
		t.Fatalf("%q", body)
	}
	// Wait for the tail to journal the 4 events.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !j.Status("run_42").Terminal {
		time.Sleep(20 * time.Millisecond)
	}
	if st := j.Status("run_42"); !st.Terminal || st.Seq != 4 {
		t.Fatalf("journal %+v", st)
	}
	broker.send(Text{T: TReq, ID: 4, Method: "GET", Path: "/v1/runs/run_42/events?since=2", Headers: map[string]string{"accept": "text/event-stream"}, Body: "none"})
	if r := broker.next(t); r.T != TRes || r.Headers["content-type"] != "text/event-stream" {
		t.Fatalf("%+v", r)
	}
	replay := broker.body(t, 4)
	if !strings.HasPrefix(replay, "id: 3\n") || !strings.Contains(replay, "id: 4\nevent: run.completed") || strings.Contains(replay, "id: 2\n") {
		t.Fatalf("replay %q", replay)
	}
	// 4. The bearer never appears in anything sent to the broker; the
	// gateway saw the local bearer and no cookie.
	for _, f := range broker.sent {
		if strings.Contains(string(f), bearer) {
			t.Fatal("bearer leaked toward the broker")
		}
	}
	for _, s := range *seen {
		if !strings.Contains(s, "auth=Bearer "+bearer) || !strings.Contains(s, "cookie=") || strings.Contains(s, "cookie=evil") {
			t.Fatalf("gateway saw %q", s)
		}
	}
	for _, s := range *seen {
		if strings.Contains(s, "credentials") {
			t.Fatal("the forbidden route reached the gateway")
		}
	}
}

func TestEnrollmentReceivesLinkIssued(t *testing.T) {
	broker := newBroker(t)
	gw, _ := fakeGateway(t)
	c := New(broker.wsURL(), Auth{EnrollmentTicket: "id.secret"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	var got []string
	c.OnLinkIssued = func(id, tok string) error { got = []string{id, tok}; return nil }
	done := make(chan error, 1)
	go func() { done <- c.Session(context.Background()) }()
	<-broker.ready
	if broker.authHdr != "Bearer enrollment:id.secret" {
		t.Fatalf("auth %q", broker.authHdr)
	}
	// Probe through the pipe, then issue.
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
	broker.next(t)
	broker.body(t, 1)
	broker.send(Text{T: TLinkIssued, RuntimeID: "rt-9", LinkToken: "T0K"})
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("session did not end after link.issued")
	}
	if len(got) != 2 || got[0] != "rt-9" || got[1] != "T0K" {
		t.Fatalf("%v", got)
	}
	_ = json.Marshal
}

// link.context is display data: it is kept on the client, handed to the
// persistence handler, and a failing handler never ends the session.
func TestLinkedClientKeepsLinkContextAndSurvivesPersistenceFailure(t *testing.T) {
	broker := newBroker(t)
	gw, _ := fakeGateway(t)
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	persisted := make(chan LinkContext, 1)
	c.OnLinkContext = func(lc LinkContext) error {
		persisted <- lc
		return errors.New("read-only state")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TLinkContext, Environment: "preprod", OHB: "https://preprod.openedbot.app", Organization: &LinkOrganization{ID: "org-1", Name: "Acme", Slug: "acme"}, Owner: &LinkOwner{Email: "owner@example.com", DisplayName: "Owner"}})
	select {
	case got := <-persisted:
		if got.Environment != "preprod" || got.OHB != "https://preprod.openedbot.app" || got.Organization.Name != "Acme" || got.Owner.Email != "owner@example.com" {
			t.Fatalf("%+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("link.context was not delivered")
	}
	broker.send(Text{T: TPing})
	broker.next(t)
	if got := c.LinkContext(); got.Environment != "preprod" || got.Owner.DisplayName != "Owner" {
		t.Fatalf("%+v", got)
	}
	select {
	case err := <-done:
		t.Fatalf("session ended on a persistence failure: %v", err)
	default:
	}
}

func TestLinkedClientPersistsRotationBeforeUsingItForReconnect(t *testing.T) {
	broker := newBroker(t)
	gw, _ := fakeGateway(t)
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "old"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	rotated := make(chan [2]string, 1)
	c.OnLinkRotated = func(id, token string) error {
		rotated <- [2]string{id, token}
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TLinkRotate, RuntimeID: "rt-1", LinkToken: "new"})
	select {
	case got := <-rotated:
		if got != [2]string{"rt-1", "new"} {
			t.Fatalf("rotation callback = %v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("rotation was not persisted")
	}
	cancel()
	<-done

	// A fresh session must authenticate with the persisted-in-memory token;
	// the daemon also writes that same token to StateDirectory for restarts.
	next := newBroker(t)
	c.WSURL = next.wsURL()
	nextCtx, nextCancel := context.WithCancel(context.Background())
	defer nextCancel()
	go func() { _ = c.Session(nextCtx) }()
	<-next.ready
	if next.authHdr != "Bearer link:rt-1.new" {
		t.Fatalf("reconnect auth = %q", next.authHdr)
	}
}

// A broker that stops answering pings must not leave the link "connected":
// the session ends so Run can reconnect. Without a keepalive a dropped NAT
// mapping produces no error at all and the runtime is unreachable for good.
func TestSessionEndsWhenPongIsMissing(t *testing.T) {
	// A raw TCP listener that completes the WebSocket handshake and then
	// stops reading: pings are never answered.
	deaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-connector.v1"}})
		if err != nil {
			return
		}
		defer c.CloseNow()
		// Read hello, then go silent for longer than the test's budget.
		_, _, _ = c.Read(context.Background())
		time.Sleep(10 * time.Second)
	}))
	defer deaf.Close()
	gw, _ := fakeGateway(t)
	c := New("ws"+strings.TrimPrefix(deaf.URL, "http"), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	c.PingInterval, c.PongTimeout = 50*time.Millisecond, 200*time.Millisecond
	done := make(chan error, 1)
	go func() { done <- c.Session(context.Background()) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the session survived a peer that never answers a ping")
	}
}

// A gateway route that never answers must not pin one of the 64 in-flight
// slots: the response-header timeout turns it into an err frame.
func TestFirstResponseIsBounded(t *testing.T) {
	broker := newBroker(t)
	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.WriteHeader(200)
	}))
	defer slow.Close()
	defer close(release)
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, slow.URL, bearer, nil)
	c.HTTP = &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 150 * time.Millisecond}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
	select {
	case f := <-broker.frames:
		if f.T != TErr || f.Code != "HERMES_UNREACHABLE" {
			t.Fatalf("%+v", f)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a gateway that never answers held the slot")
	}
}

// A gateway that refuses the connection (relaunching after a graceful
// restart) received nothing: the err frame says before_dispatch, so the
// platform requeues a run creation instead of marking it ambiguous. A gateway
// that accepted the request and then failed stays after_dispatch.
func TestRefusedGatewayDialIsBeforeDispatch(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedURL := "http://" + listener.Addr().String()
	_ = listener.Close()
	broker := newBroker(t)
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, closedURL, bearer, nil)
	c.HTTP = &http.Client{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
	select {
	case f := <-broker.frames:
		if f.T != TErr || f.Code != "HERMES_UNREACHABLE" || f.Stage != StageBeforeDispatch {
			t.Fatalf("%+v", f)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no err frame for a refused gateway")
	}
}

// Une route hôte doit atteindre l'opérateur avec sa requête. Le `model-context`
// prend son profil dans la query : perdue, l'opérateur répondait le profil
// RACINE pour chaque bot, et rien ne le disait. Les tests de l'opérateur
// appelaient le handler en direct, donc le trou n'existait que sur le fil.
func TestHostTargetKeepsTheQueryAndStripsThePrefixes(t *testing.T) {
	for _, c := range []struct{ name, in, want string }{
		{"query préservée", "/hermes-setup/model-context?profile=bot-a", "http://hermes-operator/model-context?profile=bot-a"},
		{"sans query", "/hermes-setup/capabilities", "http://hermes-operator/capabilities"},
		{"préfixe de profil retiré", "/p/bot-a/hermes-setup/model-context?profile=bot-a", "http://hermes-operator/model-context?profile=bot-a"},
		{"query vide", "/hermes-setup/model-context?", "http://hermes-operator/model-context"},
		// Ré-encodée, jamais concaténée : un `#` brut deviendrait un fragment
		// et tronquerait la requête, or l'allowlist ne regarde que le chemin.
		{"fragment neutralisé", "/hermes-setup/model-context?profile=a%23b", "http://hermes-operator/model-context?profile=a%23b"},
		{"espace encodé", "/hermes-setup/model-context?profile=a+b", "http://hermes-operator/model-context?profile=a+b"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := hostTarget(c.in)
			if err != nil {
				t.Fatalf("hostTarget(%q) a échoué : %v", c.in, err)
			}
			if got != c.want {
				t.Errorf("hostTarget(%q) = %q, attendu %q", c.in, got, c.want)
			}
		})
	}
	if _, err := hostTarget("/hermes-setup/model-context?profile=%zz"); err == nil {
		t.Error("une query malformée doit être refusée plutôt que relayée telle quelle")
	}
}

// The enrollment ticket is a bearer: it travels once, in the Authorization
// header of the TLS upgrade, and never in a frame or a log line.
func TestEnrollmentTicketStaysInTheAuthorizationHeader(t *testing.T) {
	const secret = "s3cr3t-enrollment-ticket-value"
	broker := newBroker(t)
	gw, _ := fakeGateway(t)
	c := New(broker.wsURL(), Auth{EnrollmentTicket: "3f2504e0-4f89-11d3-9a0c-0305e82c3301." + secret}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	var logs strings.Builder
	c.Logf = func(f string, a ...any) { fmt.Fprintf(&logs, f+"\n", a...) }
	c.OnLinkIssued = func(string, string) error { return nil }
	done := make(chan error, 1)
	go func() { done <- c.Session(context.Background()) }()
	<-broker.ready
	broker.send(Text{T: TLinkIssued, RuntimeID: "rt-9", LinkToken: "T0K"})
	select {
	case err := <-done:
		if err != nil && strings.Contains(err.Error(), secret) {
			t.Fatalf("session error carries the ticket: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("session did not end after link.issued")
	}
	if !strings.Contains(broker.authHdr, secret) {
		t.Fatalf("the ticket was not presented in the Authorization header: %q", broker.authHdr)
	}
	for _, f := range broker.sent {
		if strings.Contains(string(f), secret) {
			t.Fatalf("the ticket travelled in a frame: %s", f)
		}
	}
	if strings.Contains(logs.String(), secret) {
		t.Fatalf("the ticket reached the log: %s", logs.String())
	}
}

// Retire asks openedbot to revoke the runtime once the link is up, refuses
// any request meanwhile, and ends when link.retired names this runtime.
func TestRetireAsksForRevocationAndEndsOnConfirmation(t *testing.T) {
	broker := newBroker(t)
	gw, seen := fakeGateway(t)
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.Retire(ctx) }()
	<-broker.ready
	if broker.hello.T != THello {
		t.Fatalf("first frame %+v", broker.hello)
	}
	broker.send(Text{T: TPing})
	for f := broker.next(t); f.T != TLinkRetire; f = broker.next(t) {
		if f.T != TPong {
			t.Fatalf("unexpected frame before link.retire: %+v", f)
		}
	}
	broker.send(Text{T: TReq, ID: 7, Method: "GET", Path: "/health", Body: "none"})
	for f := broker.next(t); ; f = broker.next(t) {
		if f.T == TLinkRetire || f.T == TPong {
			continue
		}
		if f.T != TErr || f.ID != 7 || f.Code != "HOST_RETIRING" || f.Stage != StageBeforeDispatch {
			t.Fatalf("request served while retiring: %+v", f)
		}
		break
	}
	broker.send(Text{T: TLinkRetired, RuntimeID: "another"})
	broker.send(Text{T: TLinkRetired, RuntimeID: "rt-1"})
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Retire did not end on link.retired")
	}
	if len(*seen) != 0 {
		t.Fatalf("the gateway was reached while retiring: %v", *seen)
	}
}

func TestRetireNeedsALinkedRuntime(t *testing.T) {
	c := New("ws://127.0.0.1:1/link", Auth{EnrollmentTicket: "id.secret"}, "http://127.0.0.1:1", bearer, nil)
	if err := c.Retire(context.Background()); err == nil {
		t.Fatal("an enrollment session was asked to retire")
	}
}
