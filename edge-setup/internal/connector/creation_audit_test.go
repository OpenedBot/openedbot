package connector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var (
	testAuditMaster    = bytes.Repeat([]byte{0x11}, 32)
	testAuditMasterB   = bytes.Repeat([]byte{0x22}, 32)
	testAuditKeyFor    = func(keyID string) ([]byte, bool) { return testAuditMaster, keyID == "key-a" }
	testAuditKeyForAny = func(keyID string) ([]byte, bool) {
		switch keyID {
		case "key-a":
			return testAuditMaster, true
		case "key-b":
			return testAuditMasterB, true
		}
		return nil, false
	}
)

// armedAudit is the audit as a session with a provisioned key sees it.
func armedAudit(t *testing.T, dir string) *CreationAudit {
	t.Helper()
	audit, err := NewCreationAudit(dir, "runtime-test", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	if err := audit.Arm("key-a", testAuditMaster, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audit.Close() })
	return audit
}

// countingReader is a deterministic "random" source for vectors.
type countingReader struct{ n byte }

func (r *countingReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = r.n
		r.n++
	}
	return len(p), nil
}

func fixedClock(start time.Time) func() time.Time {
	step := 0
	return func() time.Time {
		step++
		return start.Add(time.Duration(step) * time.Second)
	}
}

func TestCreationAuditPersistsBeforeWebSocketSendFailure(t *testing.T) {
	audit := armedAudit(t, t.TempDir())
	var dispatches atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dispatches.Add(1)
		snapshot, err := OpenCreationAudit(audit.path, testAuditKeyFor)
		if err != nil || len(snapshot.Events) != 1 || snapshot.Events[0].Phase != "attempt" {
			t.Error("dispatch lacks durable attempt")
		}
		if r.Header.Get("Authorization") != "Bearer bearer-secret" {
			t.Error("gateway auth changed")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"run_id": "remote-123", "prompt":"private-response-content"}`)
	}))
	defer gateway.Close()
	client := New("", Auth{RuntimeID: "runtime-test"}, gateway.URL, "bearer-secret", nil)
	client.CreationAudit = audit
	client.serve(context.Background(), Text{T: TReq, ID: 1, Method: "POST", Path: "/p/proof-profile/v1/runs", Headers: map[string]string{"Idempotency-Key": "local-run-id"}}, func(websocket.MessageType, []byte) error { return errors.New("websocket gone") })
	snapshot, err := OpenCreationAudit(audit.path, testAuditKeyFor)
	if err != nil {
		t.Fatal(err)
	}
	if dispatches.Load() != 1 || len(snapshot.Events) != 2 {
		t.Fatalf("dispatches=%d events=%d", dispatches.Load(), len(snapshot.Events))
	}
	attempt, outcome := snapshot.Events[0], snapshot.Events[1]
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte("local-run-id")))
	if attempt.Profile != "proof-profile" || attempt.IdempotencyKeyHash != hash || attempt.CorrelationID != hash || outcome.AttemptID != attempt.AttemptID || outcome.RemoteID != "remote-123" || outcome.Status != 200 || outcome.Outcome != "response" {
		t.Fatalf("incorrect metadata: %+v", snapshot.Events)
	}
	data, _ := os.ReadFile(audit.path)
	for _, forbidden := range []string{"bearer-secret", "local-run-id", "private-response-content", "Authorization", "remote-123", "proof-profile", "attempt"} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("audit leaks %s in the clear", forbidden)
		}
	}
	info, _ := os.Stat(audit.path)
	if info.Mode().Perm() != 0o600 {
		t.Fatal("audit file is not private")
	}
	if snapshot.WriteSeq != 3 || snapshot.Count != 2 || snapshot.LastWrittenAt < snapshot.StartedAt {
		t.Fatalf("snapshot bookkeeping: %+v", snapshot)
	}
}

func TestCreationAuditAmbiguousAndRedirectOutcomesNeverRetry(t *testing.T) {
	for _, scenario := range []string{"disconnect", "missing-id", "redirect", "oversized"} {
		t.Run(scenario, func(t *testing.T) {
			audit := armedAudit(t, t.TempDir())
			var dispatches atomic.Int32
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				dispatches.Add(1)
				switch scenario {
				case "disconnect":
					conn, _, _ := w.(http.Hijacker).Hijack()
					_ = conn.Close()
				case "missing-id":
					fmt.Fprint(w, `{"ok":true}`)
				case "redirect":
					w.Header().Set("Location", "/v1/runs")
					w.WriteHeader(307)
				case "oversized":
					fmt.Fprint(w, `{"run_id":"remote-123","extra":"`+strings.Repeat("x", creationAuditResponseLimit)+`"}`)
				}
			}))
			defer gateway.Close()
			client := New("", Auth{}, gateway.URL, "secret", nil)
			client.CreationAudit = audit
			client.serve(context.Background(), Text{T: TReq, ID: 1, Method: "POST", Path: "/v1/runs", Headers: map[string]string{"Idempotency-Key": "run-id"}}, func(websocket.MessageType, []byte) error { return nil })
			snapshot, err := OpenCreationAudit(audit.path, testAuditKeyFor)
			if err != nil {
				t.Fatal(err)
			}
			expected := "ambiguous"
			if scenario == "redirect" {
				expected = "response"
			}
			if dispatches.Load() != 1 || len(snapshot.Events) != 2 || snapshot.Events[1].Outcome != expected || snapshot.Events[1].RemoteID != "" {
				t.Fatalf("invalid evidence: dispatches=%d events=%+v", dispatches.Load(), snapshot.Events)
			}
		})
	}
}

func TestCreationAuditPersistenceFailureIsNeverSuccessfulEvidence(t *testing.T) {
	for _, phase := range []string{"attempt", "outcome"} {
		t.Run(phase, func(t *testing.T) {
			audit := armedAudit(t, t.TempDir())
			original := audit.path
			var dispatches atomic.Int32
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				dispatches.Add(1)
				audit.path = filepath.Join(original, "impossible")
				fmt.Fprint(w, `{"run_id":"remote-123"}`)
			}))
			defer gateway.Close()
			if phase == "attempt" {
				audit.path = filepath.Join(original, "impossible")
			}
			client := New("", Auth{}, gateway.URL, "secret", nil)
			client.CreationAudit = audit
			client.serve(context.Background(), Text{T: TReq, ID: 1, Method: "POST", Path: "/v1/runs"}, func(websocket.MessageType, []byte) error { return nil })
			snapshot, err := OpenCreationAudit(original, testAuditKeyFor)
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if phase == "outcome" {
				want = 1
			}
			if int(dispatches.Load()) != want || len(snapshot.Events) != want {
				t.Fatalf("dispatches=%d events=%d", dispatches.Load(), len(snapshot.Events))
			}
			if want == 1 && snapshot.Events[0].Phase != "attempt" {
				t.Fatal("unresolved outcome falsely recorded")
			}
		})
	}
}

func TestCreationAuditConcurrentBoundedAndRestartCoverage(t *testing.T) {
	dir := t.TempDir()
	audit := armedAudit(t, dir)
	req, _ := http.NewRequest("POST", "http://gateway/v1/runs", nil)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := audit.attempt(req); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(audit.state.Events) != 16 {
		t.Fatal("concurrent attempts lost")
	}
	// Fill the ring (chain recomputed) so the next attempt drops the oldest
	// event: the base moves to that event's hash and the rest still verifies.
	genesis := audit.state.Base
	first := audit.state.Events[0]
	audit.state.Events = make([]CreationAuditEvent, CreationAuditLimit)
	tail, _ := hashFromHex(genesis)
	for i := range audit.state.Events {
		audit.state.Events[i] = first
		canonical, _ := canonicalJSON(first)
		tail = chainNext(tail, canonical)
	}
	audit.state.Tail = hashHex(tail)
	if _, err := audit.attempt(req); err != nil {
		t.Fatal(err)
	}
	snapshot, err := OpenCreationAudit(audit.path, testAuditKeyFor)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Dropped != 1 || len(snapshot.Events) != CreationAuditLimit || snapshot.Base == genesis {
		t.Fatal("retention is not explicit, bounded and chained")
	}
	if _, err := NewCreationAudit(dir, "runtime-test", "wss://broker.test/link"); err == nil {
		t.Fatal("concurrent writer accepted")
	}
	if err := audit.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewCreationAudit(dir, "runtime-test", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.Arm("key-a", testAuditMaster, nil); err != nil {
		t.Fatal(err)
	}
	if reopened.state.StartedAt <= snapshot.StartedAt || reopened.state.Dropped != 1 || len(reopened.state.Events) != CreationAuditLimit || reopened.state.WriteSeq != snapshot.WriteSeq+1 {
		t.Fatal("restart loses evidence or claims old coverage")
	}
}

func TestCreationAuditRefusesDispatchWithoutKey(t *testing.T) {
	audit, err := NewCreationAudit(t.TempDir(), "runtime-test", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	var dispatches atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { dispatches.Add(1) }))
	defer gateway.Close()
	client := New("", Auth{}, gateway.URL, "secret", nil)
	client.CreationAudit = audit
	var sent []Text
	client.serve(context.Background(), Text{T: TReq, ID: 1, Method: "POST", Path: "/v1/runs"}, func(_ websocket.MessageType, b []byte) error {
		f, _ := DecodeText(b)
		sent = append(sent, f)
		return nil
	})
	if dispatches.Load() != 0 || len(sent) != 1 || sent[0].T != TErr || sent[0].Code != "AUDIT_KEY_MISSING" || sent[0].Stage != StageBeforeDispatch {
		t.Fatalf("dispatches=%d frames=%+v", dispatches.Load(), sent)
	}
	if _, err := os.Stat(audit.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an unarmed audit wrote a file")
	}
	// Reads are unaffected: only creations need the key.
	if _, err := os.Stat(filepath.Join(audit.dir, "writer.lock")); err != nil {
		t.Fatal("writer lease missing")
	}
}

func TestCreationAuditVectorMatchesTestdata(t *testing.T) {
	dir := t.TempDir()
	audit, err := NewCreationAudit(dir, "runtime-vector", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	audit.random = &countingReader{}
	audit.now = fixedClock(time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC))
	if err := audit.Arm("key-vector", testAuditMaster, nil); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", "http://gateway/p/vector/v1/runs", nil)
	req.Header.Set("Idempotency-Key", "run-vector")
	attempt, err := audit.attempt(req)
	if err != nil {
		t.Fatal(err)
	}
	resp := &http.Response{StatusCode: 200, Body: http.NoBody}
	resp.Body = &auditResponseBody{Reader: strings.NewReader(`{"run_id":"remote-vector"}`), Closer: http.NoBody}
	if err := audit.outcome(attempt, resp, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(audit.path)
	plaintext, err := canonicalJSON(audit.state)
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Join("testdata", "creation-audit-v2")
	if os.Getenv("UPDATE_AUDIT_VECTORS") == "1" {
		_ = os.MkdirAll("testdata", 0o755)
		for name, data := range map[string][]byte{".bin": got, ".key.txt": []byte(hex.EncodeToString(testAuditMaster) + "\n"), ".json": append(plaintext, '\n')} {
			if err := os.WriteFile(base+name, data, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	want, err := os.ReadFile(base + ".bin")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("sealed bytes differ from testdata\n got %x\nwant %x", got, want)
	}
	wantJSON, _ := os.ReadFile(base + ".json")
	if string(bytes.TrimSpace(wantJSON)) != string(plaintext) {
		t.Fatalf("plaintext differs from testdata:\n%s", plaintext)
	}
	keyHex, _ := os.ReadFile(base + ".key.txt")
	master, _ := hex.DecodeString(strings.TrimSpace(string(keyHex)))
	snapshot, err := OpenCreationAudit(base+".bin", func(keyID string) ([]byte, bool) { return master, keyID == "key-vector" })
	if err != nil || snapshot.Count != 2 || snapshot.WriteSeq != 3 || snapshot.Events[1].RemoteID != "remote-vector" {
		t.Fatalf("testdata does not open: %v %+v", err, snapshot)
	}
	// The clear header names the key without exposing anything else.
	keyID, runtimeID, seq, err := ReadCreationAuditHeader(audit.path)
	if err != nil || keyID != "key-vector" || runtimeID != "runtime-vector" || seq != 3 {
		t.Fatalf("header %q %q %d %v", keyID, runtimeID, seq, err)
	}
	if !bytes.HasPrefix(got, []byte("OHBAUDT2\x02\x01")) {
		t.Fatalf("magic/version/suite: %x", got[:10])
	}
}

func TestCreationAuditRefusesTamperedOrForeignFiles(t *testing.T) {
	audit := armedAudit(t, t.TempDir())
	req, _ := http.NewRequest("POST", "http://gateway/v1/runs", nil)
	if _, err := audit.attempt(req); err != nil {
		t.Fatal(err)
	}
	sealed, _ := os.ReadFile(audit.path)
	write := func(t *testing.T, data []byte) string {
		p := filepath.Join(t.TempDir(), "snapshot.bin")
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	t.Run("tag altered", func(t *testing.T) {
		data := append([]byte{}, sealed...)
		data[len(data)-1] ^= 0x01
		if _, err := OpenCreationAudit(write(t, data), testAuditKeyFor); !errors.Is(err, ErrAuditAuth) {
			t.Fatalf("want auth failure, got %v", err)
		}
	})
	t.Run("header altered", func(t *testing.T) {
		data := bytes.Replace(sealed, []byte(`"writeSeq":2`), []byte(`"writeSeq":9`), 1)
		if bytes.Equal(data, sealed) {
			t.Fatal("fixture header not found")
		}
		if _, err := OpenCreationAudit(write(t, data), testAuditKeyFor); !errors.Is(err, ErrAuditAuth) {
			t.Fatalf("want auth failure on header change, got %v", err)
		}
	})
	t.Run("unknown key", func(t *testing.T) {
		if _, err := OpenCreationAudit(write(t, sealed), func(string) ([]byte, bool) { return nil, false }); !errors.Is(err, ErrAuditKeyUnknown) {
			t.Fatalf("want unknown key, got %v", err)
		}
	})
	t.Run("plaintext v1", func(t *testing.T) {
		if _, err := OpenCreationAudit(write(t, []byte(`{"schemaVersion":1,"events":[]}`)), testAuditKeyFor); !errors.Is(err, ErrAuditPlaintext) {
			t.Fatalf("want plaintext refusal, got %v", err)
		}
	})
	t.Run("writeSeq disagreement", func(t *testing.T) {
		state := audit.state
		state.WriteSeq = 42
		plaintext, _ := canonicalJSON(state)
		hdr := auditHeader{KeyID: "key-a", RuntimeID: "runtime-test", SchemaVersion: auditSchemaVersion, WriteSeq: state.WriteSeq + 1}
		data, err := sealSnapshot(hdr, plaintext, audit.key, audit.random)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := OpenCreationAudit(write(t, data), testAuditKeyFor); !errors.Is(err, ErrAuditFormat) {
			t.Fatalf("want format refusal, got %v", err)
		}
	})
}

func TestCreationAuditChainDetectsTruncationAndReordering(t *testing.T) {
	audit := armedAudit(t, t.TempDir())
	req, _ := http.NewRequest("POST", "http://gateway/v1/runs", nil)
	for i := 0; i < 3; i++ {
		if _, err := audit.attempt(req); err != nil {
			t.Fatal(err)
		}
	}
	valid := audit.state
	if err := verifyCreationAuditChain(valid); err != nil {
		t.Fatal(err)
	}
	truncated := valid
	truncated.Events = valid.Events[:2]
	truncated.Count = 2
	if err := verifyCreationAuditChain(truncated); !errors.Is(err, ErrAuditChain) {
		t.Fatalf("truncation not detected: %v", err)
	}
	reordered := valid
	reordered.Events = []CreationAuditEvent{valid.Events[1], valid.Events[0], valid.Events[2]}
	if err := verifyCreationAuditChain(reordered); !errors.Is(err, ErrAuditChain) {
		t.Fatalf("reordering not detected: %v", err)
	}
	forgedBase := valid
	forgedBase.Base = hashHex(sha256.Sum256([]byte("elsewhere")))
	if err := verifyCreationAuditChain(forgedBase); !errors.Is(err, ErrAuditChain) {
		t.Fatalf("foreign genesis not detected: %v", err)
	}
	// A sealed file whose plaintext was re-sealed after tampering (an attacker
	// holding the key is out of scope) still has to pass the chain: Arm refuses it.
	plaintext, _ := canonicalJSON(truncated)
	hdr := auditHeader{KeyID: "key-a", RuntimeID: "runtime-test", SchemaVersion: auditSchemaVersion, WriteSeq: truncated.WriteSeq}
	data, _ := sealSnapshot(hdr, plaintext, audit.key, audit.random)
	if err := os.WriteFile(audit.path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	_ = audit.Close()
	reopened, err := NewCreationAudit(filepath.Dir(audit.dir), "runtime-test", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.Arm("key-a", testAuditMaster, nil); !errors.Is(err, ErrAuditChain) || reopened.Armed() {
		t.Fatalf("broken chain armed: %v", err)
	}
}

func TestCreationAuditResealsUnderRotatedKey(t *testing.T) {
	dir := t.TempDir()
	audit := armedAudit(t, dir)
	req, _ := http.NewRequest("POST", "http://gateway/v1/runs", nil)
	if _, err := audit.attempt(req); err != nil {
		t.Fatal(err)
	}
	before, _ := OpenCreationAudit(audit.path, testAuditKeyForAny)
	_ = audit.Close()
	rotated, err := NewCreationAudit(dir, "runtime-test", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer rotated.Close()
	var anchors []AuditAnchor
	rotated.SetAnchorSink(func(a AuditAnchor) { anchors = append(anchors, a) })
	// Without the previous key the file cannot be opened, and is not discarded.
	if err := rotated.Arm("key-b", testAuditMasterB, nil); !errors.Is(err, ErrAuditKeyUnknown) {
		t.Fatalf("foreign key accepted: %v", err)
	}
	if err := rotated.Arm("key-b", testAuditMasterB, map[string][]byte{"key-a": testAuditMaster}); err != nil {
		t.Fatal(err)
	}
	keyID, _, seq, err := ReadCreationAuditHeader(rotated.path)
	if err != nil || keyID != "key-b" || seq != before.WriteSeq+1 {
		t.Fatalf("not resealed: %q %d %v", keyID, seq, err)
	}
	after, err := OpenCreationAudit(rotated.path, testAuditKeyForAny)
	if err != nil || after.Tail != before.Tail || len(after.Events) != 1 {
		t.Fatalf("chain lost across rotation: %v %+v", err, after)
	}
	if _, err := OpenCreationAudit(rotated.path, testAuditKeyFor); !errors.Is(err, ErrAuditKeyUnknown) {
		t.Fatal("old key still opens the resealed file")
	}
	if len(anchors) != 1 || anchors[0].KeyID != "key-b" || anchors[0].WriteSeq != after.WriteSeq || anchors[0].Tail != after.Tail || anchors[0].Count != 1 {
		t.Fatalf("anchor after reseal: %+v", anchors)
	}
}

func TestCreationAuditAnchorsEveryWriteInOrder(t *testing.T) {
	audit, err := NewCreationAudit(t.TempDir(), "runtime-test", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	var anchors []AuditAnchor
	audit.SetAnchorSink(func(a AuditAnchor) { anchors = append(anchors, a) })
	if _, ok := audit.Anchor(); ok {
		t.Fatal("unarmed audit has an anchor")
	}
	if err := audit.Arm("key-a", testAuditMaster, nil); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", "http://gateway/v1/runs", nil)
	for i := 0; i < 2; i++ {
		if _, err := audit.attempt(req); err != nil {
			t.Fatal(err)
		}
	}
	if len(anchors) != 3 {
		t.Fatalf("anchors: %+v", anchors)
	}
	for i, a := range anchors {
		if a.WriteSeq != uint64(i+1) || a.Count != i || a.KeyID != "key-a" || a.Dropped != 0 {
			t.Fatalf("anchor %d: %+v", i, a)
		}
	}
	snapshot, _ := OpenCreationAudit(audit.path, testAuditKeyFor)
	current, _ := audit.Anchor()
	if anchors[2].Tail != snapshot.Tail || current != anchors[2] {
		t.Fatal("anchor does not name the persisted tail")
	}
}

func TestCreationAuditSetsAsidePlaintextV1(t *testing.T) {
	root := t.TempDir()
	binding := sha256.Sum256([]byte("wss://broker.test/link\nruntime-test"))
	dir := filepath.Join(root, fmt.Sprintf("%x", binding))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	v1 := `{"schemaVersion":1,"runtimeId":"runtime-test","events":[{"eventId":"old"}]}`
	if err := os.WriteFile(filepath.Join(dir, creationAuditV1File), []byte(v1), 0o600); err != nil {
		t.Fatal(err)
	}
	audit := armedAudit(t, root)
	if _, err := os.Stat(filepath.Join(dir, creationAuditV1File)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("v1 file still in place")
	}
	kept, err := os.ReadFile(filepath.Join(dir, creationAuditV1Kept))
	if err != nil || string(kept) != v1 {
		t.Fatal("v1 file not kept intact for the operator")
	}
	snapshot, err := OpenCreationAudit(audit.path, testAuditKeyFor)
	if err != nil || snapshot.Count != 0 || snapshot.Dropped != 0 || snapshot.Base != hashHex(auditGenesis("runtime-test")) {
		t.Fatalf("v2 chain did not start at genesis: %v %+v", err, snapshot)
	}
	if _, err := OpenCreationAudit(filepath.Join(dir, creationAuditV1Kept), testAuditKeyFor); !errors.Is(err, ErrAuditPlaintext) {
		t.Fatal("v1 file read as evidence")
	}
}

func TestCanonicalJSONMatchesRFC8785Subset(t *testing.T) {
	type sample struct {
		Zed   string `json:"zed"`
		Alpha int    `json:"alpha"`
		Empty string `json:"empty,omitempty"`
		Nest  struct {
			B []string `json:"b"`
			A string   `json:"a"`
		} `json:"nest"`
	}
	var v sample
	v.Zed, v.Alpha = "<tag> & \"q\" \\ \n\t\x01 é 😀", 7
	v.Nest.A, v.Nest.B = "x", []string{"y", "z"}
	got, err := canonicalJSON(v)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\"alpha\":7,\"nest\":{\"a\":\"x\",\"b\":[\"y\",\"z\"]},\"zed\":\"<tag> & \\\"q\\\" \\\\ \\n\\t\\u0001 é 😀\"}"
	if string(got) != want {
		t.Fatalf("canonical\n got %s\nwant %s", got, want)
	}
	if _, err := canonicalJSON(map[string]any{"f": 1.5}); err == nil {
		t.Fatal("non-integer accepted")
	}
}

func TestSessionAnnouncesAuditFeatureArmsOnKeyAndAnchors(t *testing.T) {
	broker := newBroker(t)
	gw, _ := fakeGateway(t)
	dir := t.TempDir()
	audit, err := NewCreationAudit(dir, "rt-1", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	c.CreationAudit = audit
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	if len(broker.hello.Features) != 1 || broker.hello.Features[0] != FeatureCreationAuditV2 {
		t.Fatalf("hello features %v", broker.hello.Features)
	}
	// A creation before the key is refused before dispatch.
	broker.send(Text{T: TReq, ID: 1, Method: "POST", Path: "/v1/runs", Body: "none"})
	if e := broker.next(t); e.T != TErr || e.Code != "AUDIT_KEY_MISSING" || e.Stage != StageBeforeDispatch {
		t.Fatalf("%+v", e)
	}
	// The key arms the audit; the first anchor names the sealed position.
	broker.send(Text{T: TAuditKey, RuntimeID: "rt-1", KeyID: "key-a", Key: base64.StdEncoding.EncodeToString(testAuditMaster)})
	if a := broker.next(t); a.T != TAuditAnchor || a.RuntimeID != "rt-1" || a.KeyID != "key-a" || a.WriteSeq != 1 || a.Count != 0 || !auditTailRe.MatchString(a.Tail) {
		t.Fatalf("first anchor %+v", a)
	}
	broker.send(Text{T: TReq, ID: 2, Method: "POST", Path: "/v1/runs", Headers: map[string]string{"content-type": "application/json"}, Body: "stream"})
	broker.sendBinary(2, []byte(`{"input":"hi"}`))
	broker.send(Text{T: TEnd, ID: 2})
	var seq []uint64
	for len(seq) < 2 {
		f := broker.next(t)
		if f.T == TAuditAnchor {
			seq = append(seq, f.WriteSeq)
		}
	}
	if seq[0] != 2 || seq[1] != 3 {
		t.Fatalf("anchors %v", seq)
	}
	snapshot, err := OpenCreationAudit(audit.path, testAuditKeyFor)
	if err != nil || snapshot.Count != 2 || snapshot.Events[1].RemoteID != "run_42" {
		t.Fatalf("%v %+v", err, snapshot)
	}
	for _, f := range broker.sent {
		if strings.Contains(string(f), bearer) {
			t.Fatal("bearer leaked toward the broker")
		}
	}
}
