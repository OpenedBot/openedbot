//go:build integration

// Package integration drives the built binary inside a Debian 13 + systemd
// container. Network is required (apt, GitHub). Run with `make integration`.
package integration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// EDGE_SETUP_IT_BASE selects the base image (default debian:trixie). Only
// the read-only and minimal runtime scenarios are meaningful elsewhere.
func baseImage() string {
	if base := os.Getenv("EDGE_SETUP_IT_BASE"); base != "" {
		return base
	}
	return "debian:trixie"
}

func imageTag() string {
	return "edge-setup-integration:" + strings.NewReplacer(":", "-", "/", "-").Replace(baseImage())
}

func run(t *testing.T, timeout time.Duration, name string, args ...string) (string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out.String())
	}
	return out.String(), code
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Clean(filepath.Join(wd, "..", ".."))
}

type box struct {
	t    *testing.T
	name string
}

func startBox(t *testing.T) *box {
	t.Helper()
	root := repoRoot(t)
	bin := filepath.Join(root, "dist", "edge-setup")
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("build the binary first (make build): %v", err)
	}
	if out, code := run(t, 15*time.Minute, "docker", "build", "-q", "--build-arg", "BASE_IMAGE="+baseImage(), "-t", imageTag(), filepath.Join(root, "test", "integration")); code != 0 {
		t.Fatalf("docker build: %s", out)
	}
	name := fmt.Sprintf("edge-setup-it-%d", time.Now().UnixNano())
	out, code := run(t, time.Minute, "docker", "run", "-d", "--name", name, "--privileged", "--cgroupns=host",
		"--tmpfs", "/run", "--tmpfs", "/run/lock", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", imageTag())
	if code != 0 {
		t.Fatalf("docker run: %s", out)
	}
	b := &box{t: t, name: name}
	t.Cleanup(func() {
		if os.Getenv("EDGE_SETUP_IT_KEEP") == "" {
			run(t, time.Minute, "docker", "rm", "-f", name)
		} else {
			t.Logf("container %s kept", name)
		}
	})
	// Wait for systemd.
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if out, code := b.exec(time.Minute, "systemctl", "is-system-running", "--wait"); code == 0 || strings.Contains(out, "degraded") || strings.Contains(out, "running") {
			break
		}
		time.Sleep(2 * time.Second)
	}
	b.copyBinary()
	return b
}

// copyBinary puts dist/edge-setup where the tests run it (again after an
// uninstall, which removes it).
func (b *box) copyBinary() {
	b.t.Helper()
	bin := filepath.Join(repoRoot(b.t), "dist", "edge-setup")
	if out, code := run(b.t, time.Minute, "docker", "cp", bin, b.name+":/usr/local/sbin/edge-setup"); code != 0 {
		b.t.Fatalf("docker cp: %s", out)
	}
}

func (b *box) exec(timeout time.Duration, args ...string) (string, int) {
	b.t.Helper()
	return run(b.t, timeout, "docker", append([]string{"exec", b.name}, args...)...)
}

func (b *box) setup(timeout time.Duration, args ...string) (string, int) {
	b.t.Helper()
	out, code := b.exec(timeout, append([]string{"/usr/local/sbin/edge-setup"}, args...)...)
	b.t.Logf("$ edge-setup %s → %d\n%s", strings.Join(args, " "), code, tail(out, 40))
	return out, code
}

func tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func (b *box) writeFile(path, content string, mode string) {
	b.t.Helper()
	if out, code := b.exec(time.Minute, "sh", "-c", fmt.Sprintf("umask 077; printf '%%s' '%s' > %s && chmod %s %s", strings.ReplaceAll(content, "'", `'\''`), path, mode, path)); code != 0 {
		b.t.Fatalf("write %s: %s", path, out)
	}
}

// adminKey generates an ed25519 keypair; returns the authorized_keys line and
// the PEM private key.
func adminKey(t *testing.T) (string, []byte) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sshPub, _ := ssh.NewPublicKey(pub)
	block, err := ssh.MarshalPrivateKey(priv, "edge-setup-it")
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))), pem.EncodeToMemory(block)
}

func TestReadOnlyCommandsOnFreshHost(t *testing.T) {
	b := startBox(t)
	out, code := b.setup(time.Minute, "detect")
	if code != 0 || !strings.Contains(out, "reachability connector (outbound only)") {
		t.Fatalf("detect: %d %s", code, out)
	}
	if _, code := b.setup(time.Minute, "plan"); code != 0 {
		t.Fatal("plan")
	}
	if out, code := b.setup(time.Minute, "up"); code != 2 || !strings.Contains(out, "--yes") {
		t.Fatalf("up without --yes must be refused with exit 2: %d %s", code, out)
	}
	if out, code := b.setup(time.Minute, "up", "--no-ssh-hardening", "--yes"); code != 64 || !strings.Contains(out, "flag provided but not defined") {
		t.Fatalf("removed negative flags must be refused: %d %s", code, out)
	}
	if out, code := b.setup(time.Minute, "status"); code != 0 || !strings.Contains(out, "state       none") {
		t.Fatalf("status: %d %s", code, out)
	}
	if out, code := b.setup(time.Minute, "doctor"); code == 0 {
		t.Fatalf("doctor on a fresh host must fail: %s", out)
	}
}

// TestUpConnectorNoSSHHardening installs the runtime without docker (not
// possible in a container) and without SSH hardening, then proves doctor,
// the previews, uninstall (data kept, revocation attempted) and reset.
func TestUpConnectorNoSSHHardening(t *testing.T) {
	b := startBox(t)
	out, code := b.setup(40*time.Minute, "up", "--yes")
	if code != 0 {
		t.Fatalf("up: %d\n%s", code, out)
	}
	if out, code := b.setup(2*time.Minute, "doctor"); code != 0 {
		t.Fatalf("doctor: %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8642/v1/toolsets"); code != 0 || (out != "401" && out != "403") {
		t.Fatalf("anonymous toolsets: %s", out)
	}
	// There is one locked service account. Unit mount/PID namespaces, rather
	// than a second uid, isolate gateway and connector views.
	if out, code := b.exec(time.Minute, "stat", "-c", "%U:%G:%a", "/run/hermes-operator/operator.sock"); code != 0 || strings.TrimSpace(out) != "root:hermes:660" {
		t.Fatalf("operator socket: %s", out)
	}
	probe := "curl -s -o /dev/null -w '%{http_code}' --unix-socket /run/hermes-operator/operator.sock http://hermes-operator/providers/anthropic/oauth/nope"
	if out, code := b.exec(time.Minute, "runuser", "-u", "hermes", "--", "sh", "-c", probe); code != 0 || strings.TrimSpace(out) != "404" {
		t.Fatalf("operator probe as hermes: %d %s", code, out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "systemctl cat hermes-gateway | grep -q 'InaccessiblePaths=.*hermes-operator'"); code != 0 {
		t.Fatalf("gateway unit does not hide the operator socket: %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "curl -s --unix-socket /run/hermes-operator/operator.sock -X POST http://hermes-operator/exec -d '{}' -w ' %{http_code}'"); code != 0 || !strings.Contains(out, "ROUTE_UNKNOWN") || !strings.HasSuffix(strings.TrimSpace(out), "404") {
		t.Fatalf("operator unknown route: %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "command -v ufw >/dev/null && ufw status | head -1 || echo not-installed"); code != 0 || strings.Contains(out, "Status: active") {
		t.Fatalf("minimal up must not activate UFW: %s", out)
	}
	if out, code := b.exec(time.Minute, "stat", "-c", "%U:%a", "/srv/hermes/data/runtime.env"); code != 0 || strings.TrimSpace(out) != "hermes:600" {
		t.Fatalf("runtime.env: %s", out)
	}
	if out, code := b.setup(2*time.Minute, "status"); code != 0 || !strings.Contains(out, "reachability=connector") {
		t.Fatalf("status: %s", out)
	}
	// Replay is idempotent.
	if out, code := b.setup(20*time.Minute, "up", "--yes"); code != 0 {
		t.Fatalf("replay: %d\n%s", code, out)
	}
	// A linked instance whose origin is unreachable: uninstall must ask for
	// its revocation, say it was not confirmed, and remove the host anyway.
	b.writeFile("/tmp/it-link.json", `{"schema":1,"ohb":"http://127.0.0.1:9","ws_url":"ws://127.0.0.1:9/api/runtime-links/ws","runtime_id":"00000000-0000-4000-8000-0000000000aa","link_token":"it-placeholder","linked_at":"2026-10-30T00:00:00Z"}`, "0600")
	if out, code := b.exec(time.Minute, "sh", "-c", "install -d -m 0700 /etc/hermes/connector/it && install -m 0600 /tmp/it-link.json /etc/hermes/connector/it/link.json && touch /tmp/it-mark && sleep 1"); code != 0 {
		t.Fatalf("synthetic link: %s", out)
	}
	// Previews write nothing under /etc or /usr/local; they are journaled.
	if out, code := b.setup(2*time.Minute, "up", "--dry-run"); code != 0 || !strings.Contains(out, "P9 finalize") {
		t.Fatalf("up --dry-run: %d %s", code, out)
	}
	if out, code := b.setup(2*time.Minute, "uninstall", "--dry-run"); code != 0 || !strings.Contains(out, "would ask openedbot to revoke the runtime of link it") {
		t.Fatalf("uninstall --dry-run: %d %s", code, out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "find /etc /usr/local -newer /tmp/it-mark -type f"); code != 0 || strings.TrimSpace(out) != "" {
		t.Fatalf("a preview wrote files: %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", `stat -c %U:%a /var/lib/hermes-setup/journal.jsonl && grep -c '"line":"uninstall --dry-run"' /var/lib/hermes-setup/journal.jsonl`); code != 0 || !strings.HasPrefix(out, "root:600\n") {
		t.Fatalf("journal: %s", out)
	}
	out, code = b.setup(5*time.Minute, "uninstall", "--yes", "--keep-data")
	if code != 0 || !strings.Contains(out, "did not revoke runtime 00000000-0000-4000-8000-0000000000aa") || !strings.Contains(out, "uninstall complete") {
		t.Fatalf("uninstall: %d %s", code, out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "command -v edge-setup || echo none; systemctl list-unit-files 'hermes-*' --no-legend | wc -l; stat -c %U:%a /srv/hermes/data/runtime.env"); code != 0 || out != "none\n0\nhermes:600\n" {
		t.Fatalf("after uninstall --keep-data: %q", out)
	}
	b.copyBinary()
	if out, code := b.setup(5*time.Minute, "reset", "--yes", "--purge-data", "--i-understand-data-loss"); code != 0 {
		t.Fatalf("reset: %d %s", code, out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "ls /etc/hermes /srv/hermes /usr/local/lib/hermes-agent 2>&1 | grep -c 'No such'"); code != 0 || strings.TrimSpace(out) != "3" {
		t.Fatalf("residue after reset: %s", out)
	}
}

// TestHardeningLifecycle arms the lockdown, logs in through sshd inside the
// container with the admin key, commits with verify-access, then proves
// the final state; a second box lets the timer expire and proves rollback.
func TestHardeningLifecycle(t *testing.T) {
	b := startBox(t)
	pub, priv := adminKey(t)
	b.writeFile("/root/admin.pub", pub+"\n", "0600")
	out, code := b.setup(40*time.Minute, "up", "--ssh-hardening", "--quarantine-cloud-user", "--firewall", "--allow-inbound", "22/tcp", "--fail2ban", "--disable-llmnr", "--password-policy", "--sudo-logging", "--unattended-upgrades", "--admin-key", "/root/admin.pub", "--console-confirmed", "--detach", "--yes")
	if code != 0 {
		t.Fatalf("up: %d\n%s", code, out)
	}
	if out, code := b.exec(time.Minute, "cat", "/var/lib/hermes-host-hardening/active"); code != 0 || !strings.Contains(out, "state=armed") {
		t.Fatalf("not armed: %s", out)
	}
	// The container's sshd, reached from inside the container on loopback,
	// with the new admin key: this is the "new session".
	b.writeFile("/root/admin.key", string(priv), "0600")
	sshCmd := "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -i /root/admin.key hermes-admin@127.0.0.1"
	if out, code := b.exec(2*time.Minute, "sh", "-c", sshCmd+" sudo -n /usr/local/sbin/edge-setup verify-access"); code != 0 {
		t.Fatalf("verify-access over ssh: %d\n%s", code, out)
	}
	if out, code := b.exec(time.Minute, "cat", "/var/lib/hermes-host-hardening/finalized"); code != 0 || !strings.Contains(out, "admin=hermes-admin") {
		t.Fatalf("not finalized: %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "sshd -T | grep -E '^(permitrootlogin|passwordauthentication|allowusers) '"); code != 0 || !strings.Contains(out, "permitrootlogin no") || !strings.Contains(out, "allowusers hermes-admin") {
		t.Fatalf("sshd: %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "id -nG debian; getent passwd debian | cut -d: -f7; ls /home/debian/.ssh/authorized_keys /etc/sudoers.d/90-cloud-init-users 2>&1"); code == 0 && !strings.Contains(out, "No such") {
		t.Fatalf("debian not quarantined: %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "ufw status | grep -c 'ALLOW'"); code != 0 || strings.TrimSpace(out) != "2" {
		t.Fatalf("ufw allow rules (22/tcp v4+v6): %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "ufw status | grep -c 'DENY OUT'"); code != 0 || strings.TrimSpace(out) != "2" {
		t.Fatalf("ufw deny out: %s", out)
	}
	// A second `up` on a committed host resumes at P8 (resumeAfterCommit in
	// internal/commands/up.go, proven by up_test.go). What must never happen
	// is re-arming the lockout timer on a host whose access is already
	// committed: that would put a 600 s rollback back on a working machine.
	out, code = b.setup(5*time.Minute, "up", "--yes")
	if code != 0 || !strings.Contains(out, "resuming at P8") {
		t.Fatalf("replaying up on a committed host must resume at P8: %d %s", code, out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "test -e /var/lib/hermes-host-hardening/active && echo armed || echo clean"); code != 0 || !strings.Contains(out, "clean") {
		t.Fatalf("the replay re-armed the lockdown on a committed host: %s", out)
	}
	if out, code := b.exec(time.Minute, "cat", "/var/lib/hermes-host-hardening/finalized"); code != 0 || !strings.Contains(out, "admin=hermes-admin") {
		t.Fatalf("the replay lost the finalized marker: %s", out)
	}
}

func TestRollbackRestoresAccess(t *testing.T) {
	if os.Getenv("EDGE_SETUP_IT_ROLLBACK") == "" {
		t.Skip("set EDGE_SETUP_IT_ROLLBACK=1 to run the 10-minute rollback scenario")
	}
	b := startBox(t)
	pub, _ := adminKey(t)
	b.writeFile("/root/admin.pub", pub+"\n", "0600")
	if out, code := b.setup(40*time.Minute, "up", "--ssh-hardening", "--quarantine-cloud-user", "--firewall", "--allow-inbound", "22/tcp", "--fail2ban", "--disable-llmnr", "--password-policy", "--sudo-logging", "--unattended-upgrades", "--admin-key", "/root/admin.pub", "--console-confirmed", "--detach", "--yes"); code != 0 {
		t.Fatalf("up: %d\n%s", code, out)
	}
	// Do not verify: let the timer fire.
	deadline := time.Now().Add(12 * time.Minute)
	for time.Now().Before(deadline) {
		if _, code := b.exec(time.Minute, "test", "-e", "/var/lib/hermes-host-hardening/rolled-back"); code == 0 {
			break
		}
		time.Sleep(10 * time.Second)
	}
	if _, code := b.exec(time.Minute, "test", "-e", "/var/lib/hermes-host-hardening/rolled-back"); code != 0 {
		t.Fatal("no rolled-back marker after the window")
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "ls /home/debian/.ssh/authorized_keys /etc/sudoers.d/90-cloud-init-users && test ! -e /etc/ssh/sshd_config.d/00-hermes-hardening.conf && sshd -T | grep '^permitrootlogin '"); code != 0 || strings.Contains(out, "permitrootlogin no") {
		t.Fatalf("access not restored (drop-in must be gone, root login back to the image default): %s", out)
	}
	if out, code := b.exec(time.Minute, "sh", "-c", "ufw status | head -1"); code != 0 || !strings.Contains(out, "inactive") {
		t.Fatalf("ufw not restored: %s", out)
	}
}
