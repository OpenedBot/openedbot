package connector

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
)

func popClient(t *testing.T, broker *fakeBroker) (*Client, ed25519.PublicKey, *strings.Builder) {
	t.Helper()
	gw, _ := fakeGateway(t)
	priv, err := enroll.GenerateDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	c.DeviceKey = priv
	var logs strings.Builder
	var mu sync.Mutex
	c.Logf = func(f string, a ...any) {
		mu.Lock()
		defer mu.Unlock()
		logs.WriteString(strings.TrimSpace(strings.ReplaceAll(f, "%s", "%v")) + "\n")
	}
	return c, priv.Public().(ed25519.PublicKey), &logs
}

func nonceB64(fill byte) (string, []byte) {
	nonce := make([]byte, enroll.PoPNonceSize)
	for i := range nonce {
		nonce[i] = fill
	}
	return base64.StdEncoding.EncodeToString(nonce), nonce
}

func TestSessionAnswersChallengeWithVerifiableProof(t *testing.T) {
	broker := newBroker(t)
	c, pub, _ := popClient(t, broker)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	helloPub, err := enroll.ParseDevicePublicKey(broker.hello.DevicePublicKey)
	if err != nil || !helloPub.Equal(pub) {
		t.Fatalf("hello devicePublicKey %q: %v", broker.hello.DevicePublicKey, err)
	}
	encoded, nonce := nonceB64(1)
	broker.send(Text{T: TLinkChallenge, Nonce: encoded})
	proof := broker.next(t)
	if proof.T != TLinkProof || !enroll.VerifyPoP(pub, nonce, "rt-1", c.WSURL, proof.Signature) {
		t.Fatalf("proof %+v does not verify", proof)
	}
	if enroll.VerifyPoP(pub, nonce, "rt-1", "wss://other.example/api/runtime-links/ws", proof.Signature) {
		t.Fatal("proof is not bound to the dialed URL")
	}
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
	if res := broker.next(t); res.T != TRes || res.Status != 200 {
		t.Fatalf("request after proof: %+v", res)
	}
}

// Neither a pending outage diagnostic nor the anchor of an already armed audit
// may overtake link.proof: a gateway waiting for the proof refuses any other
// frame and closes the link 4401, which failed every reconnection of a running
// connector.
func TestUnsolicitedFramesWaitForProof(t *testing.T) {
	broker := newBroker(t)
	c, _, _ := popClient(t, broker)
	spool, _ := NewDiagnosticSpool(t.TempDir())
	if _, err := spool.Record("link", false, "LINK_EOF", reportingStack(), time.Now()); err != nil {
		t.Fatal(err)
	}
	c.Diagnostics = spool
	audit := armedAudit(t, t.TempDir())
	defer audit.Close()
	c.CreationAudit = audit
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	// A first broker frame confirms the session before the challenge arrives.
	broker.send(Text{T: TLinkContext, Environment: "dev", OHB: "http://127.0.0.1:8790"})
	// Room for a premature diagnostic to leave before the challenge does.
	time.Sleep(200 * time.Millisecond)
	encoded, _ := nonceB64(3)
	broker.send(Text{T: TLinkChallenge, Nonce: encoded})
	if first := broker.next(t); first.T != TLinkProof {
		t.Fatalf("first frame = %q; want %q before any anchor or diagnostic", first.T, TLinkProof)
	}
	after := map[string]bool{}
	for len(after) < 2 {
		after[broker.next(t).T] = true
	}
	if !after[TDiagnostic] || !after[TAuditAnchor] {
		t.Fatalf("frames after the proof = %v; want the anchor and the diagnostic", after)
	}
}

func TestProofChangesWithEveryNonce(t *testing.T) {
	broker := newBroker(t)
	c, pub, _ := popClient(t, broker)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	first, firstNonce := nonceB64(1)
	second, secondNonce := nonceB64(2)
	broker.send(Text{T: TLinkChallenge, Nonce: first})
	p1 := broker.next(t)
	broker.send(Text{T: TLinkChallenge, Nonce: second})
	p2 := broker.next(t)
	if p1.Signature == p2.Signature {
		t.Fatal("the same proof answered two nonces")
	}
	if !enroll.VerifyPoP(pub, secondNonce, "rt-1", c.WSURL, p2.Signature) || enroll.VerifyPoP(pub, firstNonce, "rt-1", c.WSURL, p2.Signature) {
		t.Fatal("a proof verifies under the wrong nonce")
	}
}

func TestRequestBeforeProofIsRefusedPending(t *testing.T) {
	broker := newBroker(t)
	c, _, _ := popClient(t, broker)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
	if e := broker.next(t); e.T != TErr || e.Code != "LINK_POP_PENDING" || e.Stage != StageBeforeDispatch || e.ID != 1 {
		t.Fatalf("%+v", e)
	}
	encoded, _ := nonceB64(3)
	broker.send(Text{T: TLinkChallenge, Nonce: encoded})
	if p := broker.next(t); p.T != TLinkProof {
		t.Fatalf("%+v", p)
	}
	broker.send(Text{T: TReq, ID: 2, Method: "GET", Path: "/health", Body: "none"})
	if res := broker.next(t); res.T != TRes || res.ID != 2 {
		t.Fatalf("request after proof: %+v", res)
	}
}

func TestSessionContinuesWhenBrokerNeverChallenges(t *testing.T) {
	broker := newBroker(t)
	c, _, logs := popClient(t, broker)
	c.PoPWindow = 0
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
	if res := broker.next(t); res.T != TRes || res.Status != 200 {
		t.Fatalf("older broker: %+v", res)
	}
	if !strings.Contains(logs.String(), "pop not requested") {
		t.Fatalf("logs %q", logs.String())
	}
}

func TestRekeyEndsAfterProofOrFirstFrame(t *testing.T) {
	for _, challenged := range []bool{true, false} {
		broker := newBroker(t)
		c, pub, _ := popClient(t, broker)
		done := make(chan error, 1)
		go func() { done <- c.Rekey(context.Background()) }()
		<-broker.ready
		if _, err := enroll.ParseDevicePublicKey(broker.hello.DevicePublicKey); err != nil {
			t.Fatal(err)
		}
		if challenged {
			encoded, nonce := nonceB64(4)
			broker.send(Text{T: TLinkChallenge, Nonce: encoded})
			if p := broker.next(t); !enroll.VerifyPoP(pub, nonce, "rt-1", c.WSURL, p.Signature) {
				t.Fatalf("%+v", p)
			}
		} else {
			broker.send(Text{T: TPing})
		}
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("rekey session (challenged=%v) did not end", challenged)
		}
	}
}

// The enrollment probe arrives before any challenge can exist: the runtime is
// created by the enrollment, which registers the key from hello. Refusing it
// would refuse every enrollment made with a device key.
func TestEnrollmentSessionServesTheProbeBeforeAnyProof(t *testing.T) {
	broker := newBroker(t)
	c, _, logs := popClient(t, broker)
	c.Auth = Auth{EnrollmentTicket: "enrol.secret"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
	if res := broker.next(t); res.T != TRes || res.Status != 200 || res.ID != 1 {
		t.Fatalf("enrollment probe: %+v", res)
	}
	if strings.Contains(logs.String(), "pop not requested") {
		t.Fatalf("an enrollment is not an older broker: %q", logs.String())
	}
}
