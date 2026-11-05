package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestA2AAuditTailProjectsOnlyBoundedMetadata(t *testing.T) {
	home := t.TempDir()
	lines := []string{
		`{"ts":1760000000.25,"direction":"inbound","peer":"peer-one","task_id":"task-0123456789abcdef","summary":"DROP_PRIVATE_PROMPT","tokens":991,"unknown":"DROP_UNKNOWN"}`,
		`{"ts":1760000001,"direction":"inbound","peer":"peer-two","task_id":"task-1111111111111111","source":"untrusted.origin","summary":"DROP_UNKNOWN_ORIGIN"}`,
		`{"ts":1760000001.5,"direction":"denied","peer":"peer-two","task_id":"task-3333333333333333","source":"operator.policy_probe","summary":"DROP_BAD_RECEIPT"}`,
		`not-json`,
		`{"ts":1760000002,"direction":"outbound","peer":"peer-two","task_id":"task-2222222222222222","summary":"DROP_PRIVATE_REPLY","unknown":{"nested":"DROP_NESTED"}}`,
	}
	contents := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(home, a2aAuditFile), []byte(contents), 0o600); err != nil {
		t.Fatal("could not write audit fixture")
	}

	snapshot, err := readA2AAuditTail(context.Background(), home, 10)
	if err != nil {
		t.Fatal("valid audit fixture was rejected")
	}
	if snapshot.Status != "available" || snapshot.Truncated || snapshot.SkippedRecords != 3 || len(snapshot.Records) != 2 {
		t.Fatalf("unexpected bounded audit result: status=%q truncated=%t skipped=%d records=%d",
			snapshot.Status, snapshot.Truncated, snapshot.SkippedRecords, len(snapshot.Records))
	}
	if snapshot.Records[0].Direction != "inbound" || snapshot.Records[0].Peer != "peer-one" ||
		snapshot.Records[0].TaskID != "task-0123456789abcdef" || snapshot.Records[0].TS != 1760000000.25 {
		t.Fatal("first audit record did not preserve its allowed metadata")
	}
	if snapshot.Records[0].ID != fmt.Sprintf("%s:0", a2aAuditSource) || snapshot.Records[0].Source != "upstream" {
		t.Fatal("upstream record identity was not stable and source-labeled")
	}
	wantSecondOffset := int64(len(lines[0]) + 1 + len(lines[1]) + 1 + len(lines[2]) + 1 + len(lines[3]) + 1)
	if snapshot.Records[1].ID != fmt.Sprintf("%s:%d", a2aAuditSource, wantSecondOffset) || snapshot.Records[1].Source != "upstream" {
		t.Fatal("second audit record did not use its absolute append offset")
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal("metadata response could not be encoded")
	}
	for _, forbidden := range []string{"summary", "tokens", "unknown", "DROP_PRIVATE", "DROP_UNKNOWN", "DROP_BAD_RECEIPT", "DROP_NESTED"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("private or unknown audit fields were relayed")
		}
	}
}

func TestA2AAuditMergesIndependentOffsetsAndTasklessPolicyDenial(t *testing.T) {
	home := t.TempDir()
	upstream := `{"ts":1760000000.25,"direction":"inbound","peer":"alpha","task_id":"task-0123456789abcdef","summary":"DROP_PRIVATE"}` + "\n"
	denial := `{"ts":1760000000.25,"direction":"denied","peer":"beta","source":"operator.policy_guard","method":"a2a_call","status":"blocked"}` + "\n"
	for name, body := range map[string]string{a2aAuditFile: upstream, a2aPolicyDenialFile: denial} {
		if err := os.WriteFile(filepath.Join(home, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := readA2AAuditWithPolicyDenials(context.Background(), home, 10)
	if err != nil || result.Status != "available" || len(result.Records) != 2 {
		t.Fatal("two fixed append files were not projected")
	}
	if result.Records[0].ID != "a2a_audit:0" || result.Records[1].ID != "policy_denials:0" || result.Records[1].TaskID != "" || result.Records[1].Source != a2aPolicyGuardSource {
		t.Fatal("independent offsets collided or a blocked call invented an upstream task")
	}
	encoded, err := json.Marshal(result)
	if err != nil || strings.Contains(string(encoded), "DROP_PRIVATE") || strings.Contains(string(encoded), "summary") || strings.Contains(string(encoded), "a2a_call") {
		t.Fatal("unknown or private audit fields escaped projection")
	}
	latest, err := readA2AAuditWithPolicyDenials(context.Background(), home, 1)
	if err != nil || latest.Status != "truncated" || len(latest.Records) != 1 || latest.Records[0].ID != "policy_denials:0" {
		t.Fatal("combined audit window was not bounded and ordered")
	}
}

func TestA2APolicyDenialCannotMasqueradeAsUpstreamOrProbe(t *testing.T) {
	for _, line := range []string{
		`{"ts":1760000000,"direction":"denied","peer":"beta","source":"operator.policy_probe","task_id":"task-0123456789abcdef"}`,
		`{"ts":1760000000,"direction":"outbound","peer":"beta","source":"upstream","task_id":"task-0123456789abcdef"}`,
		`{"ts":1760000000,"direction":"denied","peer":"beta","source":"operator.policy_guard","summary":"DROP_PRIVATE"}`,
		`{"ts":1760000000,"direction":"denied","peer":"beta","source":"operator.policy_guard","task_id":"untrusted-free-text"}`,
		`{"ts":1760000000,"ts":1760000001,"direction":"denied","peer":"beta","source":"operator.policy_guard"}`,
	} {
		if _, valid := parseA2AAuditRecordFromFile([]byte(line), 0, a2aPolicyDenialSource); valid {
			t.Fatal("an invalid policy receipt or source/file combination was accepted")
		}
	}
	guard := []byte(`{"ts":1760000000,"direction":"denied","peer":"beta","source":"operator.policy_guard"}`)
	if _, valid := parseA2AAuditRecord(guard, 0); valid {
		t.Fatal("a policy receipt was accepted from the upstream file")
	}
}

func TestA2AAuditTailBoundsLargeLogAndReportsTruncation(t *testing.T) {
	home := t.TempDir()
	const count = 1400
	var contents strings.Builder
	for i := 0; i < count; i++ {
		line, err := json.Marshal(map[string]any{
			"ts": float64(1760000000 + i), "direction": "inbound", "peer": "peer-one",
			"task_id": fmt.Sprintf("task-%016x", i), "summary": strings.Repeat("X", 500),
		})
		if err != nil {
			t.Fatal("could not encode large-log fixture")
		}
		contents.Write(line)
		contents.WriteByte('\n')
	}
	path := filepath.Join(home, a2aAuditFile)
	if err := os.WriteFile(path, []byte(contents.String()), 0o600); err != nil {
		t.Fatal("could not write large-log fixture")
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() <= maxA2AAuditBytes {
		t.Fatal("large-log fixture did not exceed the bounded tail size")
	}

	snapshot, err := readA2AAuditTail(context.Background(), home, 3)
	if err != nil {
		t.Fatal("bounded suffix could not be read")
	}
	if snapshot.Status != "truncated" || !snapshot.Truncated || snapshot.Limit != 3 || len(snapshot.Records) != 3 {
		t.Fatalf("large audit did not report its bounded tail: status=%q truncated=%t count=%d",
			snapshot.Status, snapshot.Truncated, len(snapshot.Records))
	}
	for i, index := range []int{count - 3, count - 2, count - 1} {
		want := fmt.Sprintf("task-%016x", index)
		if snapshot.Records[i].TaskID != want {
			t.Fatal("bounded tail did not return the newest records in order")
		}
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil || strings.Contains(string(encoded), "summary") || strings.Contains(string(encoded), strings.Repeat("X", 40)) {
		t.Fatal("large audit summary escaped its metadata projection")
	}
}

func TestA2AAuditTailSkipsOversizedRecordLine(t *testing.T) {
	home := t.TempDir()
	oversized, err := json.Marshal(map[string]any{
		"ts": 1760000000, "direction": "inbound", "peer": "peer-one",
		"task_id": "task-0123456789abcdef", "summary": "DROP_OVERSIZED_" + strings.Repeat("X", maxA2AAuditLineBytes),
	})
	if err != nil {
		t.Fatal("could not encode oversized-line fixture")
	}
	valid := `{"ts":1760000001,"direction":"outbound","peer":"peer-two","task_id":"task-1111111111111111","summary":"DROP_VALID_SUMMARY"}`
	contents := append(append(oversized, '\n'), []byte(valid+"\n")...)
	if err := os.WriteFile(filepath.Join(home, a2aAuditFile), contents, 0o600); err != nil {
		t.Fatal("could not write oversized-line fixture")
	}

	snapshot, err := readA2AAuditTail(context.Background(), home, 10)
	if err != nil || snapshot.Status != "available" || snapshot.SkippedRecords != 1 || len(snapshot.Records) != 1 {
		t.Fatal("oversized line was not bounded and skipped")
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil || strings.Contains(string(encoded), "DROP_") || strings.Contains(string(encoded), strings.Repeat("X", 40)) {
		t.Fatal("oversized record content escaped the metadata projection")
	}
}

func TestA2AAuditMissingFileIsNotReportedAsEmptyAvailable(t *testing.T) {
	snapshot, err := readA2AAuditTail(context.Background(), t.TempDir(), 4)
	if err != nil {
		t.Fatal("missing audit file should have a status response")
	}
	if snapshot.Status != "missing" || snapshot.Source != a2aAuditSource || snapshot.Limit != 4 || len(snapshot.Records) != 0 {
		t.Fatalf("missing audit file was not reported honestly: status=%q records=%d", snapshot.Status, len(snapshot.Records))
	}
}

func TestA2AAuditHandlerBoundsQueryAndInjectsReader(t *testing.T) {
	calledWith := 0
	handler := newA2AAuditHandler(func(_ context.Context, limit int) (a2aAuditSnapshot, error) {
		calledWith = limit
		return emptyA2AAuditSnapshot("missing", limit), nil
	})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/a2a/audit", nil))
	if response.Code != http.StatusOK || calledWith != defaultA2AAuditLimit {
		t.Fatal("default audit read did not use its bounded default")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/a2a/audit?limit=101", nil))
	if response.Code != http.StatusBadRequest || calledWith != defaultA2AAuditLimit {
		t.Fatal("out-of-range audit limit reached the reader")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/a2a/audit?path=%2Ftmp%2Felsewhere", nil))
	if response.Code != http.StatusBadRequest || calledWith != defaultA2AAuditLimit {
		t.Fatal("request-controlled audit path reached the reader")
	}
	response = httptest.NewRecorder()
	longQuery := "/a2a/audit?limit=" + strings.Repeat("1", maxA2AAuditQueryBytes+1)
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, longQuery, nil))
	if response.Code != http.StatusBadRequest || calledWith != defaultA2AAuditLimit {
		t.Fatal("oversized audit query reached the reader")
	}
}

func TestA2AAuditTailRejectsSymlinkedAuditFile(t *testing.T) {
	home := t.TempDir()
	external := filepath.Join(t.TempDir(), "outside.jsonl")
	if err := os.WriteFile(external, []byte(`{"ts":1760000000,"direction":"inbound","peer":"peer-one","task_id":"task-0123456789abcdef","summary":"DROP_EXTERNAL"}`+"\n"), 0o600); err != nil {
		t.Fatal("could not write external fixture")
	}
	if err := os.Symlink(external, filepath.Join(home, a2aAuditFile)); err != nil {
		t.Skip("symlinks are unavailable on this platform")
	}
	if _, err := readA2AAuditTail(context.Background(), home, 1); err == nil {
		t.Fatal("symlinked audit file was followed")
	}
}

func TestAppendA2APolicyProbeReceiptIsMetadataOnlyAndReadable(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, a2aAuditFile)
	const partialLine = `{"partial"`
	if err := os.WriteFile(path, []byte(partialLine), 0o600); err != nil {
		t.Fatal("could not write partial audit fixture")
	}
	before, err := fsx.Lstat(path)
	if err != nil || !before.Exists {
		t.Fatal("could not inspect the pre-existing audit file")
	}
	taskID := "task-0123456789abcdef"
	if err := appendA2APolicyProbeReceipt(home, "peer-one", taskID); err != nil {
		t.Fatal("valid policy receipt could not be appended")
	}
	after, err := fsx.Lstat(path)
	if err != nil || after.Owner != before.Owner || after.Mode != before.Mode {
		t.Fatal("appending changed the owner or mode of a pre-existing audit file")
	}
	snapshot, err := readA2AAuditTail(context.Background(), home, 1)
	if err != nil || len(snapshot.Records) != 1 || snapshot.SkippedRecords != 1 {
		t.Fatal("appended policy receipt could not be read")
	}
	record := snapshot.Records[0]
	wantOffset := int64(len(partialLine) + 1)
	if snapshot.Status != "available" || record.ID != fmt.Sprintf("%s:%d", a2aAuditSource, wantOffset) || record.Source != a2aPolicyProbeSource ||
		record.Direction != "denied" || record.Peer != "peer-one" || record.TaskID != taskID || record.TS <= 0 {
		t.Fatal("policy receipt metadata did not survive its bounded read")
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), `"summary":""`) || !strings.Contains(string(raw), `"source":"operator.policy_probe"`) {
		t.Fatal("host receipt did not append the required empty summary and source")
	}
	for _, forbidden := range []string{"summary text", "token", "secret"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatal("policy receipt contains caller-controlled content")
		}
	}
}

func TestAppendA2APolicyProbeReceiptRejectsInvalidMetadata(t *testing.T) {
	home := t.TempDir()
	if err := appendA2APolicyProbeReceipt(home, "peer with spaces", "task-0123456789abcdef"); err == nil {
		t.Fatal("unbounded peer identity was accepted")
	}
	if err := appendA2APolicyProbeReceipt(home, "peer-one", "not-a-task-id"); err == nil {
		t.Fatal("non-generated task identifier was accepted")
	}
	if _, err := os.Stat(filepath.Join(home, a2aAuditFile)); !os.IsNotExist(err) {
		t.Fatal("invalid policy receipt created an audit file")
	}
}

func TestAppendA2APolicyProbeReceiptCreatesPrivateFixedFile(t *testing.T) {
	home := t.TempDir()
	root, err := fsx.Lstat(home)
	if err != nil || !root.Exists {
		t.Fatal("could not inspect Hermes home")
	}
	if err := appendA2APolicyProbeReceipt(home, "peer_one", "task-0123456789abcdef"); err != nil {
		t.Fatal("valid policy receipt could not create the fixed audit file")
	}
	info, err := fsx.Lstat(filepath.Join(home, a2aAuditFile))
	if err != nil || !info.Regular || info.Symlink || info.Mode != 0o600 || info.Owner != root.Owner {
		t.Fatal("new policy audit file did not inherit the verified Hermes owner and private mode")
	}
}

func TestAppendA2APolicyProbeReceiptCreatesRuntimeOwnedFileAsRoot(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires Linux peer ownership semantics")
	}
	if os.Geteuid() != 0 {
		t.Skip("requires root to create a Hermes-owned fixture")
	}

	const runtimeUID, runtimeGID = 999, 989
	account, err := user.Lookup("hermes")
	if err != nil || account.Uid != "999" || account.Gid != "989" {
		t.Skip("requires the lab Hermes account with UID 999 and GID 989")
	}
	home, err := os.MkdirTemp("", "openedbot84-receipt-owner-")
	if err != nil {
		t.Fatal("could not create the isolated fixture")
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	if err := os.Chown(home, runtimeUID, runtimeGID); err != nil {
		t.Fatal("could not assign the isolated fixture to the Hermes UID/GID")
	}
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal("could not make the isolated Hermes fixture private")
	}
	if err := appendA2APolicyProbeReceipt(home, "peer_one", "task-0123456789abcdef"); err != nil {
		t.Fatal("root operator could not append to the isolated Hermes fixture")
	}
	info, err := fsx.Lstat(filepath.Join(home, a2aAuditFile))
	if err != nil || !info.Regular || info.Symlink || info.Mode != 0o600 ||
		info.Owner != (fsx.Owner{UID: runtimeUID, GID: runtimeGID}) {
		t.Fatal("root-created receipt file was not readable by the Hermes owner")
	}
	// Run as the actual service account, without touching its runtime or unit.
	cmd := osexec.Command("/usr/sbin/runuser", "-u", "hermes", "--", "/usr/bin/tee", "-a", filepath.Join(home, a2aAuditFile))
	cmd.Stdin = strings.NewReader("runtime-owner-append-proof\n")
	if err := cmd.Run(); err != nil {
		t.Fatal("the Hermes account could not append to its new audit file")
	}
	contents, err := os.ReadFile(filepath.Join(home, a2aAuditFile))
	if err != nil || !strings.Contains(string(contents), "runtime-owner-append-proof") {
		t.Fatal("the runtime append was not read back")
	}
}

func TestAppendA2APolicyProbeReceiptDoesNotFollowSymlink(t *testing.T) {
	home := t.TempDir()
	external := filepath.Join(t.TempDir(), "outside.jsonl")
	const untouched = "leave this target unchanged\n"
	if err := os.WriteFile(external, []byte(untouched), 0o600); err != nil {
		t.Fatal("could not write external fixture")
	}
	if err := os.Symlink(external, filepath.Join(home, a2aAuditFile)); err != nil {
		t.Skip("symlinks are unavailable on this platform")
	}
	if err := appendA2APolicyProbeReceipt(home, "peer_one", "task-0123456789abcdef"); err == nil {
		t.Fatal("policy receipt followed a symlinked audit file")
	}
	after, err := os.ReadFile(external)
	if err != nil || string(after) != untouched {
		t.Fatal("symlink rejection changed the external audit target")
	}
}
