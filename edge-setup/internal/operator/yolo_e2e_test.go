package operator

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/coder/websocket"
)

// One hook call per stdin line, as Hermes would make it; yolo.json and
// hardline.json are whatever the operator left in the profile.
const yoloE2EDriver = `import importlib.util,json,sys,types
ctx=types.SimpleNamespace(register_hook=lambda name,fn: setattr(ctx,'hook',fn))
spec=importlib.util.spec_from_file_location('plugin',sys.argv[1]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); mod.register(ctx)
call=json.load(sys.stdin)
kwargs={'args':call['args']}
if call.get('session'): kwargs['session_id']=call['session']
print(json.dumps(ctx.hook(call['tool'],**kwargs)))
`

const (
	e2eRuntime = "8f3b2c1d-1111-4222-8333-444455556666"
	e2eLeaseA  = "5d0c7f3e-9a41-4b7e-8c2d-3f6a1b0e9d01"
	e2eLeaseB  = "5d0c7f3e-9a41-4b7e-8c2d-3f6a1b0e9d02"
)

// The host side of YOLO end to end, without any network: a signed lease
// accepted by the connector's store, applied by the connector loop through
// the operator's socket into the profile, enforced by the approval plugin
// run by python3, its spool drained into the local audit and reported; then
// the plugin's own expiry with the connector stopped, the loop withdrawing
// the elapsed lease, and `yolo off` written while the daemon runs.
func TestYoloHostEndToEnd(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	root, svc := yoloRoot(t, "designer")
	pluginDir := filepath.Join(root, "profiles", "designer", "plugins", approvalPolicyPlugin)
	plugin, err := approvalPolicyFiles.ReadFile("approval_policy_plugin/__init__.py")
	if err != nil {
		t.Fatal(err)
	}
	stubs := filepath.Join(root, "stubs")
	files := map[string][]byte{
		filepath.Join(pluginDir, "__init__.py"): plugin,
		filepath.Join(pluginDir, "policy.json"): []byte(`{"mode":"ask_writes"}`),
	}
	for name, body := range approvalGateStubs {
		files[filepath.Join(stubs, name)] = []byte(body)
	}
	for path, body := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// The operator on its Unix socket (short path: macOS caps it at 104 bytes).
	sockDir, err := os.MkdirTemp("", "yolo-e2e")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockDir) })
	socket := filepath.Join(sockDir, "op.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: (&Server{YoloApply: svc.apply, YoloDrain: svc.drain, YoloDrained: svc.drained}).Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client := &connector.Client{OperatorSocket: socket}

	// The connector: lease store and audit under its state directory.
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i)
	}
	key := ed25519.NewKeyFromSeed(seed)
	public := key.Public().(ed25519.PublicKey)
	pin := connector.YoloLeaseKey{KeyID: connector.YoloLeaseKeyID(public), PublicKey: base64.StdEncoding.EncodeToString(public)}
	sign := func(id string, issued, expires int64) *connector.YoloFrame {
		designer := "designer"
		l := connector.YoloLease{V: 1, LeaseID: id, OrganizationID: "0b1f5a8e-3c2d-4e6f-9a7b-1c2d3e4f5a6b", RuntimeID: e2eRuntime, Scope: "bot",
			Profile: &designer, IssuedAt: issued, NotBefore: issued, ExpiresAt: expires, GrantedBy: "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d",
			Protect: []string{"git_config", "git_hooks", "ssh", "env", "id_rsa", "credentials", "keychain"}}
		l.Deny.Commands, l.Deny.Tools, l.Deny.Paths = []string{}, []string{}, []string{}
		message, err := connector.YoloLeaseMessage(l)
		if err != nil {
			t.Fatal(err)
		}
		return &connector.YoloFrame{Lease: &l, KeyID: pin.KeyID, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, message))}
	}
	stateDir := t.TempDir()
	store, err := connector.OpenYoloStore(stateDir, e2eRuntime, []connector.YoloLeaseKey{pin}, time.Now, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Stop)
	audit, err := connector.OpenYoloAudit(stateDir, e2eRuntime, nil)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var sent []connector.Text
	y := &connector.Yolo{Store: store, Audit: audit, Apply: client.ApplyYolo, Drain: client.DrainYolo, Drained: client.DrainedYolo, Logf: t.Logf, Tick: 50 * time.Millisecond}
	detach := y.Attach(func(_ websocket.MessageType, b []byte) error {
		f, err := connector.DecodeText(b)
		if err != nil {
			return err
		}
		mu.Lock()
		sent = append(sent, f)
		mu.Unlock()
		return nil
	})
	defer detach()
	start := func() context.CancelFunc {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { y.Run(ctx); close(done) }()
		return func() { cancel(); <-done }
	}

	hook := func(tool string, args map[string]any) string {
		t.Helper()
		input, _ := json.Marshal(map[string]any{"tool": tool, "args": args})
		cmd := exec.Command(python, "-c", yoloE2EDriver, filepath.Join(pluginDir, "__init__.py"))
		cmd.Stdin = bytes.NewReader(input)
		cmd.Env = append(os.Environ(), "PYTHONPATH="+stubs, "PYTHONDONTWRITEBYTECODE=1")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("plugin driver: %v\n%s", err, stderr.String())
		}
		var result *struct{ Action string }
		if err := json.Unmarshal(out, &result); err != nil {
			t.Fatalf("plugin answer %q: %v", out, err)
		}
		if result == nil {
			return "pass"
		}
		return map[string]string{"approve": "ask", "block": "block"}[result.Action]
	}
	yoloPath := filepath.Join(pluginDir, yoloFile)
	exists := func(path string) bool { _, err := os.Stat(path); return err == nil }
	eventually := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("timeout: %s", what)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	lastState := func() *connector.YoloFrame {
		mu.Lock()
		defer mu.Unlock()
		for i := len(sent) - 1; i >= 0; i-- {
			if sent[i].T == "yolo.state" {
				return sent[i].Yolo
			}
		}
		return nil
	}
	audited := func() []connector.YoloAuditEntry {
		mu.Lock()
		defer mu.Unlock()
		var out []connector.YoloAuditEntry
		for _, f := range sent {
			if f.T == "yolo.audit" {
				out = append(out, f.Yolo.Entries...)
			}
		}
		return out
	}
	tmpWrite := map[string]any{"path": "/tmp/yolo-e2e/out.md", "content": "rapport"}

	// Without a lease, a write asks.
	stop := start()
	if got := hook("write_file", tmpWrite); got != "ask" {
		t.Fatalf("no lease: %s", got)
	}

	// 1. A signed lease, valid 4 s: applied, enforced, audited with the hash only.
	now := time.Now().Unix()
	if err := store.Accept(sign(e2eLeaseA, now-10, now+4)); err != nil {
		t.Fatal(err)
	}
	eventually("the lease reached the profile", func() bool { return exists(yoloPath) })
	if got := hook("write_file", tmpWrite); got != "pass" {
		t.Fatalf("a /tmp write under the lease: %s", got)
	}
	for name, call := range map[string]struct {
		tool string
		args map[string]any
	}{
		".ssh":           {"write_file", map[string]any{"path": "/home/hermes/.ssh/authorized_keys", "content": "k"}},
		".env":           {"write_file", map[string]any{"path": "/srv/app/.env", "content": "K=v"}},
		"hardline path":  {"write_file", map[string]any{"path": "/home/hermes/.hermes/SOUL.md", "content": "x"}},
		"hardline shell": {"terminal", map[string]any{"command": "sudo rm -rf / --no-preserve-root"}},
	} {
		if got := hook(call.tool, call.args); got != "block" {
			t.Errorf("%s under the lease: %s, want block", name, got)
		}
	}
	eventually("the auto-approval reached the audit", func() bool { return len(audited()) == 1 })
	entry := audited()[0]
	if entry.LeaseID != e2eLeaseA || entry.GateKind != "plugin_tool" || entry.ToolKey == nil || *entry.ToolKey != "write_file" || len(entry.ArgsHash) != 64 {
		t.Fatalf("audit entry %+v", entry)
	}
	for _, dir := range []string{stateDir, pluginDir} {
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || strings.HasSuffix(path, ".py") {
				return err
			}
			if data, _ := os.ReadFile(path); bytes.Contains(data, []byte("/tmp/yolo-e2e")) || bytes.Contains(data, []byte("rapport")) {
				t.Errorf("%s holds the arguments in clear", path)
			}
			return nil
		})
	}
	if state := lastState(); state == nil || len(state.Leases) != 1 || state.Leases[0].Status != "active" {
		t.Fatalf("state %+v", state)
	}

	// 2. The connector stops before the expiry: the plugin alone stops the lease.
	stop()
	time.Sleep(time.Until(time.Unix(now+4, 0)) + 200*time.Millisecond)
	if !exists(yoloPath) {
		t.Fatal("yolo.json vanished with the connector stopped: the test proves nothing")
	}
	if got := hook("write_file", tmpWrite); got != "ask" {
		t.Fatalf("an elapsed lease, connector dead: %s", got)
	}
	// Back up, the loop withdraws the elapsed lease and reports it.
	stop = start()
	defer func() { stop() }()
	eventually("the elapsed lease left the profile", func() bool { return !exists(yoloPath) })
	eventually("the expiry was reported", func() bool {
		s := lastState()
		return s != nil && len(s.Leases) == 1 && s.Leases[0].Status == "expired"
	})

	// 3. `yolo off` while the daemon runs: the profile is emptied, the kill reported, a replay refused.
	now = time.Now().Unix()
	frame := sign(e2eLeaseB, now-1, now+3600)
	if err := store.Accept(frame); err != nil {
		t.Fatal(err)
	}
	eventually("the second lease reached the profile", func() bool { return exists(yoloPath) })
	if got := hook("write_file", tmpWrite); got != "pass" {
		t.Fatalf("a /tmp write under the second lease: %s", got)
	}
	if err := connector.WriteYoloKill(stateDir, connector.YoloKill{KilledAt: now}, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	eventually("yolo off emptied the profile", func() bool { return !exists(yoloPath) })
	if got := hook("write_file", tmpWrite); got != "ask" {
		t.Fatalf("a write after yolo off: %s", got)
	}
	eventually("the kill was reported", func() bool { s := lastState(); return s != nil && s.KilledAt != nil && *s.KilledAt == now })
	var issue *connector.YoloLeaseIssue
	if err := store.Accept(frame); !errors.As(err, &issue) || connector.IssueCode(err) != "killed" {
		t.Fatalf("a lease issued before the kill was accepted again: %v", err)
	}
}
