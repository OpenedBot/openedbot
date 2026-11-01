package hardening

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseOperatorIP(t *testing.T) {
	for _, tc := range []struct{ name, in, want string }{
		{"ipv4 session", "203.0.113.45 54321 10.0.0.5 22", "203.0.113.45"},
		{"ipv6 session", "2001:db8::1 54321 2001:db8::2 22", "2001:db8::1"},
		{"ipv4-mapped is unmapped", "::ffff:203.0.113.45 1 2 3", "203.0.113.45"},
		{"address alone", "203.0.113.45", "203.0.113.45"},
		{"empty", "", ""},
		{"not an address", "console 1 2 3", ""},
		{"loopback adds nothing", "127.0.0.1 1 2 3", ""},
		{"unspecified never exempts the internet", "0.0.0.0 1 2 3", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseOperatorIP(tc.in); got != tc.want {
				t.Fatalf("ParseOperatorIP(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestMergeIgnoreIPKeepsLoopbackAndAccumulates(t *testing.T) {
	first := MergeIgnoreIP("", "203.0.113.45")
	if first != "127.0.0.1/8 ::1 203.0.113.45" {
		t.Fatalf("first converge = %q", first)
	}
	jail := "[DEFAULT]\nusedns = no\nignoreip = " + first + "\n"
	// A second workstation must not evict the first.
	second := MergeIgnoreIP(jail, "203.0.113.7")
	if second != "127.0.0.1/8 ::1 203.0.113.45 203.0.113.7" {
		t.Fatalf("second converge = %q", second)
	}
	// Re-running from the same address rewrites identical bytes.
	if again := MergeIgnoreIP(jail, "203.0.113.45"); again != first {
		t.Fatalf("idempotent converge = %q, want %q", again, first)
	}
	// A console run keeps whatever earlier runs earned.
	if console := MergeIgnoreIP(jail, ""); console != first {
		t.Fatalf("console converge = %q, want %q", console, first)
	}
}

func TestMergeIgnoreIPOnAJailWithoutTheKey(t *testing.T) {
	if got := MergeIgnoreIP("[DEFAULT]\nbantime = 1h\n", ""); got != LoopbackIgnoreIP {
		t.Fatalf("got %q, want %q", got, LoopbackIgnoreIP)
	}
}

// fakeProcTable is a chain pid -> (ppid, environ).
func fakeProcTable(self int, chain map[int]struct {
	ppid    int
	environ string
}) ProcTable {
	return ProcTable{
		Self: self,
		PPid: func(pid int) (int, error) {
			e, ok := chain[pid]
			if !ok {
				return 0, fmt.Errorf("no such pid %d", pid)
			}
			return e.ppid, nil
		},
		Environ: func(pid int) (string, error) {
			e, ok := chain[pid]
			if !ok {
				return "", fmt.Errorf("no such pid %d", pid)
			}
			return e.environ, nil
		},
	}
}

type procEntry = struct {
	ppid    int
	environ string
}

// The real shape: sudo strips SSH_CONNECTION, so the value is only found on
// the login shell two hops up. Reading $SSH_CONNECTION would return "".
func TestDetectOperatorIPClimbsPastSudo(t *testing.T) {
	got := DetectOperatorIP(fakeProcTable(100, map[int]procEntry{
		100: {ppid: 90, environ: "PATH=/usr/bin\x00EDGE_SETUP_NO_SUDO=1\x00"},
		90:  {ppid: 80, environ: "PATH=/usr/bin\x00SUDO_USER=hermes-admin\x00"},
		80:  {ppid: 70, environ: "SSH_CONNECTION=203.0.113.45 54321 10.0.0.5 22\x00"},
		70:  {ppid: 1, environ: ""},
	}))
	if got != "203.0.113.45" {
		t.Fatalf("got %q, want the SSH peer two hops up", got)
	}
}

func TestDetectOperatorIPOnAConsoleRun(t *testing.T) {
	got := DetectOperatorIP(fakeProcTable(100, map[int]procEntry{
		100: {ppid: 90, environ: "PATH=/usr/bin\x00"},
		90:  {ppid: 1, environ: "TERM=linux\x00"},
	}))
	if got != "" {
		t.Fatalf("got %q, want no address for a console run", got)
	}
}

func TestDetectOperatorIPTerminatesOnALoopedTable(t *testing.T) {
	done := make(chan string, 1)
	go func() {
		done <- DetectOperatorIP(fakeProcTable(100, map[int]procEntry{
			100: {ppid: 100, environ: ""},
		}))
	}()
	if got := <-done; got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

// An unreadable environ mid-chain must not stop the climb: the answer may
// still be one hop further up.
func TestDetectOperatorIPSkipsAnUnreadableEnviron(t *testing.T) {
	p := fakeProcTable(100, map[int]procEntry{
		100: {ppid: 90, environ: ""},
		90:  {ppid: 80, environ: ""},
		80:  {ppid: 1, environ: "SSH_CONNECTION=203.0.113.7 1 2 3\x00"},
	})
	inner := p.Environ
	p.Environ = func(pid int) (string, error) {
		if pid == 90 {
			return "", fmt.Errorf("permission denied")
		}
		return inner(pid)
	}
	if got := DetectOperatorIP(p); got != "203.0.113.7" {
		t.Fatalf("got %q, want 203.0.113.7", got)
	}
}

// The whole point: the rendered jail must carry the operator's address.
func TestRenderedJailExemptsTheOperator(t *testing.T) {
	h := &Hardener{Fail2banJail: "/nonexistent/sshd.local", OperatorIP: func() string { return "203.0.113.45" }}
	out, err := h.renderFail2banJail()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "ignoreip = 127.0.0.1/8 ::1 203.0.113.45") {
		t.Fatalf("jail does not exempt the operator:\n%s", out)
	}
}

// A hand-written 10-*.conf must survive a converge from the console: fail2ban
// lets the later "sshd.local" override it, so the union has to be preserved.
func TestRenderedJailKeepsAnExemptionFromAnotherFragment(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "10-hermes-operator.conf"),
		[]byte("[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 203.0.113.45\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A console run: no SSH peer to detect.
	h := &Hardener{Fail2banJail: filepath.Join(dir, "sshd.local"), OperatorIP: func() string { return "" }}
	out, err := h.renderFail2banJail()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "ignoreip = 127.0.0.1/8 ::1 203.0.113.45") {
		t.Fatalf("converge dropped the hand-written exemption:\n%s", out)
	}
}

func TestExistingIgnoreIPCollectsEveryFragment(t *testing.T) {
	got := existingIgnoreIP("[DEFAULT]\nignoreip = 1.2.3.4\n[sshd]\nignoreip = 5.6.7.8\n")
	if got != "1.2.3.4 5.6.7.8" {
		t.Fatalf("got %q, want both addresses", got)
	}
}
