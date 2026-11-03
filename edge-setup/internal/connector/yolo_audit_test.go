package connector

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var updateYoloAuditVector = flag.Bool("update-yolo-audit-vector", false, "rewrite testdata/creation-audit-v2-yolo.* (then copy them to openedbot)")

func record(lease string) YoloAuditRecord {
	tool := "write_file"
	return YoloAuditRecord{LeaseID: lease, Profile: "designer", GateKind: YoloGatePluginTool, ToolKey: &tool, ArgsHash: strings.Repeat("a", 64)}
}

func TestYoloAuditChainSurvivesAReload(t *testing.T) {
	dir := t.TempDir()
	audit, err := OpenYoloAudit(dir, testRuntime, nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := audit.Record(record(leaseA))
	if err != nil {
		t.Fatal(err)
	}
	second, err := audit.Record(record(leaseA))
	if err != nil || second.Seq != 2 || second.PrevHash != first.EntryHash || first.PrevHash != YoloAuditGenesis(testRuntime) {
		t.Fatalf("chain: %+v %+v %v", first, second, err)
	}
	info, err := os.Stat(filepath.Join(dir, yoloPendingFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("outbox: %v %v", err, info)
	}
	// The same event delivered twice (a plugin spool drained again) is one entry.
	again, err := audit.Record(YoloAuditRecord{EventID: second.EventID, LeaseID: leaseA, Profile: "designer", GateKind: YoloGatePluginTool, ArgsHash: strings.Repeat("a", 64)})
	if err != nil || again.Seq != 2 || audit.Pending() != 2 {
		t.Fatalf("duplicate chained: %+v %v", again, err)
	}
	// A crash mid-line: the cut line was never confirmed and is dropped.
	f, _ := os.OpenFile(filepath.Join(dir, yoloPendingFile), os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"seq":3,"eventId":`)
	_ = f.Close()
	reopened, err := OpenYoloAudit(dir, testRuntime, nil)
	if err != nil || reopened.Pending() != 2 {
		t.Fatalf("reopen: %v pending=%d", err, reopened.Pending())
	}
	if third, err := reopened.Record(record(leaseA)); err != nil || third.Seq != 3 || third.PrevHash != second.EntryHash {
		t.Fatalf("after reload: %+v %v", third, err)
	}
	// A tampered entry breaks the chain: nothing is auto-approved on it.
	data, _ := os.ReadFile(filepath.Join(dir, yoloPendingFile))
	_ = os.WriteFile(filepath.Join(dir, yoloPendingFile), bytes.Replace(data, []byte(`"profile":"designer"`), []byte(`"profile":"writer"`), 1), 0o600)
	if _, err := OpenYoloAudit(dir, testRuntime, nil); !errors.Is(err, ErrAuditChain) {
		t.Fatalf("tampered outbox opened: %v", err)
	}
}

func TestYoloAuditUnwritableMeansNoRecord(t *testing.T) {
	dir := t.TempDir()
	audit, err := OpenYoloAudit(dir, testRuntime, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, yoloPendingFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := audit.Record(record(leaseA)); err == nil {
		t.Fatal("a record that could not be written was reported durable")
	}
	if audit.Pending() != 0 {
		t.Fatal("an unwritten record is pending")
	}
}

func TestYoloAuditPendingUntilArmedThenSealedAndPurged(t *testing.T) {
	dir := t.TempDir()
	creation, err := NewCreationAudit(filepath.Join(dir, "creation-audit"), testRuntime, "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer creation.Close()
	audit, err := OpenYoloAudit(dir, testRuntime, nil)
	if err != nil {
		t.Fatal(err)
	}
	audit.SetSealer(creation.appendYolo)
	// Unarmed (a restart while the link is down): recorded, pending, unsealed.
	entry, err := audit.Record(record(leaseA))
	if err != nil {
		t.Fatal(err)
	}
	if audit.state.SealedThrough != 0 {
		t.Fatal("sealed without a key")
	}
	// openedbot acknowledges before the key arrives: kept until sealed.
	if err := audit.Ack(entry.Seq); err != nil || audit.Pending() != 1 {
		t.Fatalf("purged before sealing: %v pending=%d", err, audit.Pending())
	}
	if err := creation.Arm("key-a", testAuditMaster, nil); err != nil {
		t.Fatal(err)
	}
	audit.Seal()
	if audit.Pending() != 0 || audit.state.SealedThrough != 1 {
		t.Fatalf("after arm: pending=%d sealed=%d", audit.Pending(), audit.state.SealedThrough)
	}
	snapshot, err := OpenCreationAudit(creation.path, testAuditKeyFor)
	if err != nil || len(snapshot.Events) != 1 {
		t.Fatalf("sealed audit: %v %+v", err, snapshot)
	}
	event := snapshot.Events[0]
	if event.Kind != CreationAuditKindYolo || event.LeaseID != leaseA || event.ArgsHash != entry.ArgsHash || event.ToolKey != "write_file" || event.EventID != entry.EventID {
		t.Fatalf("sealed event %+v", event)
	}
	// The chain continues past the purge, across a reload.
	reopened, err := OpenYoloAudit(dir, testRuntime, nil)
	if err != nil {
		t.Fatal(err)
	}
	next, err := reopened.Record(record(leaseA))
	if err != nil || next.Seq != 2 || next.PrevHash != entry.EntryHash {
		t.Fatalf("after purge: %+v %v", next, err)
	}
}

func TestYoloAuditBatchesDecodeAsFrames(t *testing.T) {
	audit, err := OpenYoloAudit(t.TempDir(), testRuntime, nil)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := audit.Record(record(leaseA)); err != nil {
			t.Fatal(err)
		}
	}
	batch := audit.NextBatch(2)
	frame, err := EncodeYoloAudit(testRuntime, batch)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeText(frame)
	if err != nil || decoded.Yolo.FromSeq != 1 || decoded.Yolo.ToSeq != 2 {
		t.Fatalf("decode: %v %+v", err, decoded.Yolo)
	}
	// openedbot checks the hashes it receives: they are the chain's.
	for _, e := range decoded.Yolo.Entries {
		if want, _ := YoloEntryHash(e); want != e.EntryHash {
			t.Fatalf("entry %d hash", e.Seq)
		}
	}
	if rest := audit.NextBatch(10); len(rest) != 1 || rest[0].Seq != 3 {
		t.Fatalf("rest %+v", rest)
	}
	audit.StartSession()
	if all := audit.NextBatch(10); len(all) != 3 {
		t.Fatalf("a new session resends what is not acknowledged: %d", len(all))
	}
}

// openedbot drops a yolo.audit received before it admits the link: what
// stays unacknowledged goes out again, and nothing once it is acknowledged.
func TestYoloAuditResendsWhatStaysUnacknowledged(t *testing.T) {
	clock := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	audit, err := OpenYoloAudit(t.TempDir(), testRuntime, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := audit.Record(record(leaseA)); err != nil {
			t.Fatal(err)
		}
	}
	audit.StartSession()
	if sent := audit.NextBatch(10); len(sent) != 2 {
		t.Fatalf("first send: %d", len(sent))
	}
	if audit.Resend(15*time.Second) || len(audit.NextBatch(10)) != 0 {
		t.Fatal("resent before the delay")
	}
	clock = clock.Add(16 * time.Second)
	if !audit.Resend(15 * time.Second) {
		t.Fatal("unacknowledged audit not resent")
	}
	if again := audit.NextBatch(10); len(again) != 2 || again[0].Seq != 1 {
		t.Fatalf("resend: %+v", again)
	}
	if err := audit.Ack(2); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Minute)
	if audit.Resend(15 * time.Second) {
		t.Fatal("acknowledged audit resent")
	}
}

// The vector openedbot's decoder reads: a sealed audit holding one run
// creation and one YOLO auto-approval (creation-audit-v2-yolo.*).
func TestCreationAuditYoloVectorMatchesTestdata(t *testing.T) {
	dir := t.TempDir()
	audit, err := NewCreationAudit(dir, "runtime-vector", "wss://broker.test/link")
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	audit.random = &countingReader{}
	audit.now = fixedClock(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	if err := audit.Arm("key-vector", testAuditMaster, nil); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", "http://gateway/p/vector/v1/runs", nil)
	req.Header.Set("Idempotency-Key", "run-vector")
	if _, err := audit.attempt(req); err != nil {
		t.Fatal(err)
	}
	tool := "write_file"
	entry := YoloAuditEntry{Seq: 1, EventID: "3c2b1a00-0000-4000-8000-000000000007", OccurredAt: 1793491307, LeaseID: "5d0c7f3e-9a41-4b7e-8c2d-3f6a1b0e9d01",
		Profile: "vector", GateKind: YoloGatePluginTool, ToolKey: &tool, ArgsHash: YoloArgsHash(`{"path":"notes/todo.md"}`)}
	if err := audit.appendYolo(entry); err != nil {
		t.Fatal(err)
	}
	terminal := YoloAuditEntry{Seq: 2, EventID: "3c2b1a00-0000-4000-8000-000000000008", OccurredAt: 1793491308, LeaseID: entry.LeaseID,
		Profile: "vector", GateKind: YoloGateTerminalDanger, ArgsHash: YoloArgsHash("rm -rf ./build")}
	if err := audit.appendYolo(terminal); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(audit.path)
	plaintext, err := canonicalJSON(audit.state)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(plaintext, []byte("notes/todo.md")) || bytes.Contains(plaintext, []byte("./build")) {
		t.Fatal("arguments reached the audit in clear")
	}
	base := filepath.Join("testdata", "creation-audit-v2-yolo")
	if os.Getenv("UPDATE_AUDIT_VECTORS") == "1" || *updateYoloAuditVector {
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
		t.Fatal("sealed bytes differ from testdata (UPDATE_AUDIT_VECTORS=1 to rewrite, then copy to openedbot)")
	}
	wantJSON, _ := os.ReadFile(base + ".json")
	if string(bytes.TrimSpace(wantJSON)) != string(plaintext) {
		t.Fatalf("plaintext differs from testdata:\n%s", plaintext)
	}
	snapshot, err := OpenCreationAudit(base+".bin", func(keyID string) ([]byte, bool) { return testAuditMaster, keyID == "key-vector" })
	if err != nil || snapshot.Count != 3 || snapshot.Events[1].Kind != CreationAuditKindYolo || snapshot.Events[2].ToolKey != "" {
		t.Fatalf("testdata does not open: %v %+v", err, snapshot)
	}
}

// The terminal half: a native approval the lease covers is answered after the
// audit entry is durable; anything doubtful is left to a human.
func TestYoloObserveAnswersCoveredTerminalGates(t *testing.T) {
	key := newSigner(0)
	start := time.Now().Unix()
	session := "ohb-session-1"
	block := func(command, pattern string) string {
		return `data: {"event":"approval.request","run_id":"run_abc","command":"` + command + `","pattern_key":"` + pattern + `","request_id":"req-1","choices":["once","session","always","deny"]}`
	}
	cases := []struct {
		name       string
		lease      func() YoloLease
		block      string
		session    string
		breakAudit bool
		want       bool
	}{
		{"covered terminal gate", func() YoloLease { return testLease(leaseA, "bot", start, 3600) }, block("rm -rf ./build", "recursive delete"), "", false, true},
		{"thread lease, its session", func() YoloLease {
			l := testLease(leaseA, "thread", start, 3600)
			k := SessionKey(session)
			l.SessionKey = &k
			return l
		}, block("rm -rf ./build", "recursive delete"), session, false, true},
		{"thread lease, unknown session", func() YoloLease {
			l := testLease(leaseA, "thread", start, 3600)
			k := SessionKey(session)
			l.SessionKey = &k
			return l
		}, block("rm -rf ./build", "recursive delete"), "", false, false},
		{"hardline command", func() YoloLease { return testLease(leaseA, "bot", start, 3600) }, block("rm -rf /", "recursive delete"), "", false, false},
		{"protected command", func() YoloLease { return testLease(leaseA, "bot", start, 3600) }, block("cat ~/.ssh/id_ed25519", "read"), "", false, false},
		{"plugin gate is the plugin's", func() YoloLease { return testLease(leaseA, "bot", start, 3600) }, block("<write_file> (plugin approval rule)", "plugin_rule:ohb/v1/write_file"), "", false, false},
		{"audit cannot be written", func() YoloLease { return testLease(leaseA, "bot", start, 3600) }, block("rm -rf ./build", "recursive delete"), "", true, false},
		{"another profile", func() YoloLease {
			l := testLease(leaseA, "bot", start, 3600)
			l.Profile = strp("writer")
			return l
		}, block("rm -rf ./build", "recursive delete"), "", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			store := openTestStore(t, dir, newClock(start), key.pin)
			if err := store.Accept(key.frame(t, c.lease())); err != nil {
				t.Fatal(err)
			}
			audit, err := OpenYoloAudit(dir, testRuntime, nil)
			if err != nil {
				t.Fatal(err)
			}
			if c.breakAudit {
				_ = os.Mkdir(filepath.Join(dir, yoloPendingFile), 0o700)
			}
			var answered []string
			y := &Yolo{Store: store, Audit: audit, Logf: t.Logf, Approve: func(_ context.Context, prefix, runID, requestID string) error {
				answered = append(answered, prefix+" "+runID+" "+requestID)
				return nil
			}}
			y.NoteRun("run_abc", "/p/designer", c.session)
			y.Observe(context.Background(), "run_abc", "/p/designer", c.block)
			if (len(answered) == 1) != c.want {
				t.Fatalf("answered %v, want %v", answered, c.want)
			}
			if c.want && (answered[0] != "/p/designer run_abc req-1" || audit.Pending() != 1) {
				t.Fatalf("answer %v pending %d", answered, audit.Pending())
			}
			if !c.want && audit.Pending() != 0 {
				t.Fatal("an unanswered gate was recorded as auto-approved")
			}
		})
	}
}

// One pass applies the active set, reports it, and follows `yolo off` written
// while the daemon kept running.
func TestYoloPassAppliesReportsAndFollowsTheKill(t *testing.T) {
	key := newSigner(0)
	start := time.Now().Unix()
	dir := t.TempDir()
	store := openTestStore(t, dir, newClock(start), key.pin)
	audit, _ := OpenYoloAudit(dir, testRuntime, nil)
	var applied [][]YoloLease
	var sent [][]byte
	y := &Yolo{Store: store, Audit: audit, Logf: t.Logf, Apply: func(_ context.Context, active []YoloLease) error {
		applied = append(applied, active)
		return nil
	}}
	detach := y.Attach(func(_ websocket.MessageType, b []byte) error { sent = append(sent, b); return nil })
	defer detach()
	if err := store.Accept(key.frame(t, testLease(leaseA, "runtime", start, 3600))); err != nil {
		t.Fatal(err)
	}
	y.pass(context.Background())
	if len(applied) != 1 || len(applied[0]) != 1 {
		t.Fatalf("applied %v", applied)
	}
	if len(sent) != 1 || !strings.Contains(string(sent[0]), `"status":"active"`) {
		t.Fatalf("sent %q", sent)
	}
	if err := WriteYoloKill(dir, YoloKill{KilledAt: start}, fileOwner()); err != nil {
		t.Fatal(err)
	}
	y.pass(context.Background())
	if len(applied) != 2 || len(applied[1]) != 0 {
		t.Fatalf("the kill did not empty the profiles: %v", applied)
	}
	decoded, err := DecodeText(sent[len(sent)-1])
	if err != nil || decoded.Yolo.KilledAt == nil || *decoded.Yolo.KilledAt != start {
		t.Fatalf("state after kill: %v %+v", err, decoded.Yolo)
	}
}
