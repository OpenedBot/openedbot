// Package access implements `verify-access`: the proof, from a session
// opened after the lockdown, that the administrator can still reach the
// host with the new policy. Only that session commits the hardening.
package access

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
)

// Session is what the verifier can observe about the calling session.
type Session struct {
	SudoUser string
	SudoUID  string
	EUID     int
	// SessionID is /proc/self/sessionid, empty when unavailable.
	SessionID string
}

// Verifier proves and commits.
type Verifier struct {
	Runner exec.Runner
	Guard  *guard.Guard
	Env    func(string) string
	EUID   int
	Now    func() time.Time
	// ProcRoot overrides /proc (tests).
	ProcRoot string
}

// New wires a verifier at the canonical paths.
func New(r exec.Runner) *Verifier {
	return &Verifier{Runner: r, Guard: guard.Default(r), Env: os.Getenv, EUID: os.Geteuid(), Now: time.Now}
}

// Proof is what was established.
type Proof struct {
	AdminUser           string
	AdminKeyFingerprint string
	EnforcedAt          time.Time
	RemoteHost          string
}

// Verify proves the calling session is a fresh SSH login of the admin with
// sudo, opened after enforce, and that the host refuses the old paths. It
// mutates nothing.
func (v *Verifier) Verify(ctx context.Context) (Proof, error) {
	var p Proof
	g := v.Guard
	if err := requireMarker(g); err != nil {
		return p, err
	}
	kv, err := g.ReadMarker(g.Active())
	if err != nil {
		return p, err
	}
	p.AdminUser, p.AdminKeyFingerprint = kv["admin"], kv["admin_key"]
	enforced, _ := strconv.ParseInt(kv["enforced_at"], 10, 64)
	if enforced == 0 || (p.AdminUser == "") != (p.AdminKeyFingerprint == "") {
		return p, errors.New("the active marker does not describe an armed lockdown")
	}
	p.EnforcedAt = time.Unix(enforced, 0)
	if err := g.Systemd.RequireTimerWaiting(ctx, g.Timer()); err != nil {
		return p, err
	}
	if v.EUID != 0 {
		return p, errors.New("verify-access must run as root through sudo")
	}
	if p.AdminUser == "" {
		remote, err := v.proveSSHSession(ctx, p)
		if err != nil {
			return p, err
		}
		p.RemoteHost = remote
		return p, nil
	}
	if v.Env("SUDO_USER") != p.AdminUser {
		return p, fmt.Errorf("verify-access must be invoked with `sudo` by %s from a NEW SSH session (SUDO_USER=%q)", p.AdminUser, v.Env("SUDO_USER"))
	}
	remote, err := v.proveSSHSession(ctx, p)
	if err != nil {
		return p, err
	}
	p.RemoteHost = remote
	since := p.EnforcedAt.UTC().Format("2006-01-02 15:04:05 UTC")
	journal, err := exec.Output(ctx, v.Runner, "/usr/bin/journalctl", "-u", "ssh.service", "--since", since, "--no-pager", "-o", "cat")
	if err != nil {
		return p, err
	}
	ok, defect := hardening.AcceptedPublickey(journal, p.AdminUser, p.AdminKeyFingerprint)
	if defect != "" {
		return p, errors.New(defect)
	}
	if !ok {
		return p, fmt.Errorf("no `Accepted publickey for %s … %s` in the sshd journal since the lockdown; open a NEW SSH session and retry", p.AdminUser, p.AdminKeyFingerprint)
	}
	out, err := exec.Output(ctx, v.Runner, "/usr/sbin/sshd", "-T")
	if err != nil {
		return p, err
	}
	if err := hardening.RequireSSHDHardened(hardening.SSHDEffective(out), p.AdminUser); err != nil {
		return p, err
	}
	// Negative proofs on loopback: it is the sshd configuration we test; the
	// network path was proven by the accepted login above.
	for _, user := range []string{"root", p.AdminUser} {
		res, err := v.Runner.Run(ctx, exec.Cmd{Path: "/usr/bin/ssh", Args: []string{
			"-o", "BatchMode=yes", "-o", "PubkeyAuthentication=no", "-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5", user + "@127.0.0.1", "true",
		}, Timeout: 30 * time.Second})
		if err != nil {
			return p, err
		}
		if res.ExitCode == 0 {
			return p, fmt.Errorf("sshd still accepts %s without a public key", user)
		}
	}
	return p, nil
}

func requireMarker(g *guard.Guard) error {
	if !fsx.Exists(g.Active()) {
		if fsx.Exists(g.Finalized()) {
			return errors.New("hardening already finalized; nothing to verify")
		}
		if fsx.Exists(g.RolledBack()) {
			return errors.New("the rollback already restored the previous access; re-run `up` after investigating")
		}
		return errors.New("no lockdown is armed")
	}
	_, err := fsx.RequireRegular(g.Active(), 0o600, g.Owner)
	return err
}

// proveSSHSession proves the calling session is an sshd login of the admin
// opened after enforce, via loginctl, with a /proc fallback.
func (v *Verifier) proveSSHSession(ctx context.Context, p Proof) (string, error) {
	sid, _ := os.ReadFile("/proc/self/sessionid")
	id := strings.TrimSpace(string(sid))
	if id != "" && id != "4294967295" {
		out, err := exec.Output(ctx, v.Runner, "/usr/bin/loginctl", "show-session", id, "-p", "Service", "-p", "Remote", "-p", "RemoteHost", "-p", "Name", "-p", "Timestamp")
		if err == nil {
			kv := map[string]string{}
			for _, line := range strings.Split(out, "\n") {
				if k, val, ok := strings.Cut(line, "="); ok {
					kv[k] = val
				}
			}
			wrongUser := p.AdminUser != "" && kv["Name"] != p.AdminUser
			if kv["Service"] != "sshd" || kv["Remote"] != "yes" || wrongUser {
				return "", fmt.Errorf("the calling session is not a fresh remote sshd login (Service=%s Remote=%s Name=%s)", kv["Service"], kv["Remote"], kv["Name"])
			}
			if ts, err := time.Parse("Mon 2006-01-02 15:04:05 MST", kv["Timestamp"]); err == nil && !ts.After(p.EnforcedAt) {
				return "", errors.New("the calling session predates the lockdown; open a NEW SSH session")
			}
			return kv["RemoteHost"], nil
		}
	}
	// sudo drops SSH_CONNECTION and a container may have no logind session:
	// walk the parent chain to the sshd process that owns this session and
	// require it to have started after the lockdown. SSH_CONNECTION is only
	// a source for the peer address, never a proof of freshness: `sudo -E`
	// or an env_keep would otherwise let a session opened BEFORE the
	// lockdown commit it, which is exactly what this gate exists to stop.
	remote, started, err := sshdAncestor(v.ProcRoot)
	if err != nil {
		return "", fmt.Errorf("the calling session is not an SSH session (no loginctl session, no sshd ancestor, %v)", err)
	}
	if !started.After(p.EnforcedAt) {
		return "", errors.New("the calling session's sshd predates the lockdown; open a NEW SSH session")
	}
	if remote == "" {
		if conn := v.Env("SSH_CONNECTION"); conn != "" {
			remote = strings.Fields(conn)[0]
		}
	}
	return remote, nil
}

// sshdAncestor finds the closest `sshd: <user>` ancestor of this process and
// returns its remote peer (when readable) and start time.
func sshdAncestor(procRoot string) (string, time.Time, error) {
	if procRoot == "" {
		procRoot = "/proc"
	}
	btime, err := bootTime(procRoot)
	if err != nil {
		return "", time.Time{}, err
	}
	pid := os.Getpid()
	for depth := 0; depth < 32 && pid > 1; depth++ {
		stat, err := os.ReadFile(fmt.Sprintf("%s/%d/stat", procRoot, pid))
		if err != nil {
			return "", time.Time{}, err
		}
		s := string(stat)
		// comm is in parentheses and may contain spaces; fields follow it.
		close := strings.LastIndex(s, ")")
		if close < 0 {
			return "", time.Time{}, errors.New("unreadable /proc stat")
		}
		fields := strings.Fields(s[close+1:])
		if len(fields) < 20 {
			return "", time.Time{}, errors.New("short /proc stat")
		}
		ppid, _ := strconv.Atoi(fields[1])
		cmdline, _ := os.ReadFile(fmt.Sprintf("%s/%d/cmdline", procRoot, pid))
		cmd := strings.ReplaceAll(string(cmdline), "\x00", " ")
		if strings.HasPrefix(cmd, "sshd: ") || strings.HasPrefix(cmd, "sshd-session: ") {
			ticks, _ := strconv.ParseInt(fields[19], 10, 64)
			started := btime.Add(time.Duration(ticks) * time.Second / 100)
			remote := "unknown"
			if env, err := os.ReadFile(fmt.Sprintf("%s/%d/environ", procRoot, pid)); err == nil {
				for _, kv := range strings.Split(string(env), "\x00") {
					if v, ok := strings.CutPrefix(kv, "SSH_CONNECTION="); ok {
						remote = strings.Fields(v)[0]
					}
				}
			}
			return remote, started, nil
		}
		pid = ppid
	}
	return "", time.Time{}, errors.New("no sshd ancestor")
}

func bootTime(procRoot string) (time.Time, error) {
	data, err := os.ReadFile(procRoot + "/stat")
	if err != nil {
		return time.Time{}, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if v, ok := strings.CutPrefix(line, "btime "); ok {
			n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			if err != nil {
				return time.Time{}, err
			}
			return time.Unix(n, 0), nil
		}
	}
	return time.Time{}, errors.New("btime not found")
}
