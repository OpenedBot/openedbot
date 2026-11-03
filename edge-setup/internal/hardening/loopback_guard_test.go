package hardening

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

// EnsureLoopbackGuard runs on every replayed `up` and every upgrade of a host
// with a firewall: a guard already in place must not be rewritten or restarted.
func loopbackGuardedHost(t *testing.T) (*Hardener, *exectest.Fake) {
	t.Helper()
	fake := exectest.NewFake()
	fake.On("/usr/bin/getent passwd hermes", exec.Result{Stdout: "hermes:x:998:998::/srv/hermes:/usr/sbin/nologin\n"})
	fake.On("/usr/sbin/iptables -w -S OUTPUT", exec.Result{Stdout: "-P OUTPUT ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 0 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 0 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -j REJECT --reject-with icmp-port-unreachable\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n"})
	h := New(fake, func(string, ...any) {})
	h.Accounts.Lookup = func(string) (*user.User, error) {
		return &user.User{Username: "hermes", Uid: "998", Gid: "998", HomeDir: "/srv/hermes"}, nil
	}
	h.LoopbackGuardPath = filepath.Join(t.TempDir(), "hermes-loopback-guard.service")
	unit, err := loopbackGuardUnit([]int{0, 998})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.LoopbackGuardPath, []byte(unit), 0o644); err != nil {
		t.Fatal(err)
	}
	return h, fake
}

func TestEnsureLoopbackGuardLeavesAGuardedHostAlone(t *testing.T) {
	h, fake := loopbackGuardedHost(t)
	installed, err := h.EnsureLoopbackGuard(context.Background())
	if err != nil || installed {
		t.Fatalf("installed=%v err=%v", installed, err)
	}
	for _, call := range fake.Commands() {
		if call != "/usr/bin/getent passwd hermes" && call != "/usr/sbin/iptables -w -S OUTPUT" {
			t.Fatalf("a guarded host must only be read, ran %q", call)
		}
	}
}

// A guard installed by an older build keeps its rules but not its
// confinement: the unit this build renders replaces it.
func TestEnsureLoopbackGuardRefreshesAnOlderUnit(t *testing.T) {
	h, fake := loopbackGuardedHost(t)
	if err := os.WriteFile(h.LoopbackGuardPath, []byte("[Service]\nType=oneshot\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fake.OnPrefix("/usr/bin/systemctl", exec.Result{})
	installed, err := h.EnsureLoopbackGuard(context.Background())
	if !installed {
		t.Fatal("an older unit was left in place")
	}
	// The unit is written root-owned: only a root test run can check it.
	if os.Geteuid() != 0 {
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(h.LoopbackGuardPath); !strings.Contains(string(data), "IPAddressDeny=any") {
		t.Fatalf("unit not refreshed:\n%s", data)
	}
}
