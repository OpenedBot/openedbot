package connector

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDiagnosticSpoolSurvivesRestartUntilAcknowledged(t *testing.T) {
	dir := t.TempDir()
	spool, err := NewDiagnosticSpool(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := spool.Record("link", true, "LINK_RECOVERED", "", now); err != nil {
		t.Fatal(err)
	}
	if len(spool.Pending()) != 0 {
		t.Fatal("healthy startup created an incident")
	}
	for i := 0; i < 3; i++ {
		if _, err := spool.Record("link", false, "LINK_EOF", reportingStack(), now); err != nil {
			t.Fatal(err)
		}
	}
	pending := spool.Pending()
	if len(pending) != 1 {
		t.Fatalf("duplicate incident: %d", len(pending))
	}
	if !strings.Contains(pending[0].Stack, "TestDiagnosticSpoolSurvivesRestartUntilAcknowledged") {
		t.Fatal("missing reporting stack")
	}
	restarted, err := NewDiagnosticSpool(dir)
	if err != nil {
		t.Fatal(err)
	}
	if restarted.Pending()[0].EventID != pending[0].EventID {
		t.Fatal("replay changed the idempotency key")
	}
	if err := restarted.Ack(pending[0].EventID); err != nil {
		t.Fatal(err)
	}
	restarted, err = NewDiagnosticSpool(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(restarted.Pending()) != 0 {
		t.Fatal("acknowledged incident replayed")
	}
	if _, err := restarted.Record("link", true, "LINK_RECOVERED", "", now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if event := restarted.Pending()[0]; event.State != "recovered" || event.Stack != "" {
		t.Fatalf("recovery: %+v", event)
	}
	stat, _ := os.Stat(filepath.Join(dir, "pending.json"))
	if stat.Mode().Perm() != 0o600 {
		t.Fatal("diagnostic spool is not private")
	}
}

func TestDiagnosticSpoolBoundsAndRejectsMalformedDiskData(t *testing.T) {
	dir := t.TempDir()
	spool, _ := NewDiagnosticSpool(dir)
	drops := 0
	for i := 0; i < DiagnosticQueueLimit+3; i++ {
		dropped, err := spool.Record("link", i%2 != 0, "LINK_EOF", "", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if dropped {
			drops++
		}
	}
	if drops != 3 || len(spool.state.Events) != DiagnosticQueueLimit || len(spool.Pending()) != 4 {
		t.Fatal("spool/replay is not bounded")
	}
	if err := os.WriteFile(filepath.Join(dir, "pending.json"), []byte(`{"events":[{"t":"diagnostic","eventId":"bad"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewDiagnosticSpool(dir); err == nil {
		t.Fatal("malformed disk event accepted")
	}
}

func TestDiagnosticSpoolDoesNotCrossRuntimeOrServerBindings(t *testing.T) {
	dir := t.TempDir()
	original, _ := NewRuntimeDiagnosticSpool(dir, "runtime-a", "wss://first.example/ws")
	if _, err := original.Record("link", false, "LINK_EOF", reportingStack(), time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, binding := range [][2]string{{"runtime-b", "wss://first.example/ws"}, {"runtime-a", "wss://second.example/ws"}} {
		other, err := NewRuntimeDiagnosticSpool(dir, binding[0], binding[1])
		if err != nil || len(other.Pending()) != 0 {
			t.Fatal("previous binding incidents leaked into new enrollment")
		}
	}
	reopened, _ := NewRuntimeDiagnosticSpool(dir, "runtime-a", "wss://first.example/ws")
	if len(reopened.Pending()) != 1 {
		t.Fatal("original binding lost its pending diagnostic")
	}
}

func TestDiagnosticContainsCauseAndReportingStackWithoutErrorSecrets(t *testing.T) {
	spool, _ := NewDiagnosticSpool(t.TempDir())
	client := New("", Auth{}, "", "", nil)
	client.Diagnostics = spool
	secret := "Bearer secret-token https://discord.com/api/webhooks/123/private"
	client.reportHealth("link", false, reportableError(errors.New(secret), "LINK_DIAL_FAILED"))
	event := spool.Pending()[0]
	b, _ := EncodeText(event)
	if strings.Contains(string(b), "secret-token") || strings.Contains(string(b), "private") || strings.Contains(string(b), "webhooks") {
		t.Fatal("error credentials leaked")
	}
	if event.Code != "LINK_DIAL_FAILED" || !strings.Contains(event.Stack, "TestDiagnosticContainsCause") {
		t.Fatal("cause/stack missing")
	}
	wrapped := reportableError(io.EOF, "LINK_EOF")
	if !errors.Is(wrapped, io.EOF) {
		t.Fatal("error chain lost")
	}
}

func TestDiagnosticClassifiesNetworkCausesWithoutRetainingHostDetails(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{io.EOF, "LINK_EOF"},
		{syscall.ECONNRESET, "LINK_CONNECTION_RESET"},
		{syscall.ECONNREFUSED, "LINK_CONNECTION_REFUSED"},
		{&net.DNSError{Name: "private-host", Err: "secret detail"}, "LINK_DNS_FAILED"},
	} {
		diagnostic := reportableError(tc.err, "LINK_DIAL_FAILED").(*diagnosticError)
		if diagnostic.code != tc.code {
			t.Fatalf("code=%s want=%s", diagnostic.code, tc.code)
		}
		if strings.Contains(diagnosticMessage(diagnostic.code), "private-host") || strings.Contains(diagnostic.stack, "secret detail") {
			t.Fatal("private error text retained")
		}
	}
}

func TestDiagnosticDeliveryReplaysOnSameLinkUntilAck(t *testing.T) {
	broker := newBroker(t)
	spool, _ := NewDiagnosticSpool(t.TempDir())
	if _, err := spool.Record("link", false, "LINK_EOF", reportingStack(), time.Now()); err != nil {
		t.Fatal(err)
	}
	eventID := spool.Pending()[0].EventID
	client := New(broker.wsURL(), Auth{RuntimeID: "fixture", LinkToken: "test"}, "", "", nil)
	client.Diagnostics = spool
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	done := make(chan error, 1)
	go func() { done <- client.Session(ctx) }()
	defer func() { cancel(); <-done }()
	<-broker.ready
	broker.send(Text{T: TPing})
	var received Text
	for received.T != TDiagnostic {
		received = broker.next(t)
	}
	if received.EventID != eventID || received.State != "unavailable" {
		t.Fatal("pending outage not replayed")
	}
	if len(spool.Pending()) != 2 {
		t.Fatal("send removed incident before ACK or recovery missing")
	}
	broker.send(Text{T: TDiagnosticAck, EventID: received.EventID})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && len(spool.Pending()) != 1 {
		time.Sleep(time.Millisecond)
	}
	if pending := spool.Pending(); len(pending) != 1 || pending[0].State != "recovered" {
		t.Fatal("ACK did not remove exactly its persisted event")
	}
	broker.send(Text{T: TPing})
	for broker.next(t).T != TPong {
	}
	if client.Diagnostics.Pending()[0].State != "recovered" {
		t.Fatal("link state changed during delivery")
	}
}
