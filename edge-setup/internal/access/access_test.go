package access

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
)

const unit = "hermes-hardening-rollback"

func newVerifier(t *testing.T, env map[string]string) (*Verifier, *exectest.Fake) {
	t.Helper()
	f := exectest.NewFake()
	f.OnPrefix("/usr/bin/systemctl enable", exec.Result{})
	f.OnPrefix("/usr/bin/systemctl restart", exec.Result{})
	f.On("/usr/bin/systemctl show "+unit+".timer --property=ActiveState --value", exec.Result{Stdout: "active\n"})
	f.On("/usr/bin/systemctl show "+unit+".timer --property=SubState --value", exec.Result{Stdout: "waiting\n"})
	f.On("/usr/bin/systemctl show "+unit+".timer --property=NextElapseUSecMonotonic --value", exec.Result{Stdout: "99\n"})
	root := t.TempDir()
	g := guard.New(filepath.Join(root, "state"), filepath.Join(root, "backup"), unit, fsx.Current(), f)
	g.LockWait = time.Second
	_ = g.EnsureDirs()
	v := &Verifier{Runner: f, Guard: g, Env: func(k string) string { return env[k] }, EUID: 0, Now: time.Now}
	return v, f
}

func TestVerifyRefusesWithoutArmedLockdown(t *testing.T) {
	v, _ := newVerifier(t, nil)
	if _, err := v.Verify(context.Background()); err == nil || !strings.Contains(err.Error(), "no lockdown is armed") {
		t.Fatalf("%v", err)
	}
}

func TestVerifyRefusesWrongCaller(t *testing.T) {
	v, _ := newVerifier(t, map[string]string{"SUDO_USER": "debian"})
	// The guard's owner is the test user, so marker checks pass on tmpfs.
	if err := v.Guard.Arm(context.Background(), guard.ArmParams{AdminUser: "hermes-admin", AdminKeyFingerprint: "SHA256:" + strings.Repeat("a", 43), EnforcedAt: time.Now().Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	v.Guard.Owner = fsx.Current()
	_, err := v.Verify(context.Background())
	if err == nil || !strings.Contains(err.Error(), "SUDO_USER") {
		t.Fatalf("a caller other than the admin must be refused: %v", err)
	}
	v2, _ := newVerifier(t, map[string]string{"SUDO_USER": "hermes-admin"})
	v2.EUID = 1000
	_ = v2.Guard.Arm(context.Background(), guard.ArmParams{AdminUser: "hermes-admin", AdminKeyFingerprint: "SHA256:" + strings.Repeat("a", 43), EnforcedAt: time.Now()})
	if _, err := v2.Verify(context.Background()); err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("non-root caller must be refused: %v", err)
	}
}

// writeProcEntry builds one /proc/<pid> fixture: stat (ppid + start ticks)
// and cmdline. Ticks are 100 Hz since the boot time written by procFixture.
func writeProcEntry(t *testing.T, root string, pid, ppid int, cmdline string, startTicks int64) {
	t.Helper()
	dir := filepath.Join(root, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// After the closing parenthesis the reader indexes state=0, ppid=1,
	// starttime=19. State is written separately, so ppid is the first of
	// the trailing fields and starttime the nineteenth.
	fields := make([]string, 22)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0] = strconv.Itoa(ppid)
	fields[18] = strconv.FormatInt(startTicks, 10)
	stat := strconv.Itoa(pid) + " (proc) S " + strings.Join(fields, " ") + "\n"
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cmdline"), []byte(strings.ReplaceAll(cmdline, " ", "\x00")), 0o644); err != nil {
		t.Fatal(err)
	}
}

// SSH_CONNECTION says where a session came from, never when it started. A
// session opened BEFORE the lockdown that still carries the variable (sudo
// -E, an env_keep) must not be able to commit the transaction: the sshd
// ancestor's start time is the only proof of freshness.
func TestSSHConnectionCannotCommitAPreLockdownSession(t *testing.T) {
	root := t.TempDir()
	boot := time.Now().Add(-2 * time.Hour)
	if err := os.WriteFile(filepath.Join(root, "stat"), []byte(fmt.Sprintf("btime %d\n", boot.Unix())), 0o644); err != nil {
		t.Fatal(err)
	}
	// The sshd ancestor started one hour after boot; the lockdown is now.
	writeProcEntry(t, root, 1, 0, "systemd", 0)
	writeProcEntry(t, root, 2, 1, "sshd: hermes-admin@pts/0", int64(time.Hour/time.Second)*100)
	writeProcEntry(t, root, os.Getpid(), 2, "edge-setup verify-access", int64(90*time.Minute/time.Second)*100)

	v, _ := newVerifier(t, map[string]string{"SSH_CONNECTION": "203.0.113.7 4242 198.51.100.1 22"})
	v.ProcRoot = root
	p := Proof{AdminUser: "hermes-admin", EnforcedAt: time.Now()}
	if _, err := v.proveSSHSession(context.Background(), p); err == nil || !strings.Contains(err.Error(), "predates the lockdown") {
		t.Fatalf("a pre-lockdown session with SSH_CONNECTION was accepted: %v", err)
	}
	// The same session, opened after the lockdown, is accepted and the peer
	// falls back to SSH_CONNECTION when /proc/<sshd>/environ is unreadable.
	p.EnforcedAt = boot
	remote, err := v.proveSSHSession(context.Background(), p)
	if err != nil {
		t.Fatalf("a fresh session was refused: %v", err)
	}
	if remote != "unknown" && remote != "203.0.113.7" {
		t.Fatalf("unexpected peer %q", remote)
	}
}
