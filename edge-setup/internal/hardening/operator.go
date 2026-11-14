package hardening

import (
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

// The operator's own address must never be banned by the jail this tool
// installs.
//
// `up` installs fail2ban and then closes the first-contact account: the
// signed baseline is "AllowUsers <admin>" and the account the operator
// arrived on can no longer open a session. An operator who then retries the
// old account out of habit, or whose tooling does, spends `maxretry`
// failed publickey auths and gets the SOURCE ADDRESS banned. fail2ban bans
// an IP, not an account, so the ban also severs the admin access this very
// run just created, and the host is reachable only through the provider's
// out-of-band console.
//
// Measured on 2026-09-03 against a Hostinger VPS: five connection attempts
// under different account names, then every subsequent connection refused,
// on a host whose sshd was listening and whose UFW allowed 22/tcp. With
// `bantime.increment = true` and `bantime.maxtime = 1d`, waiting it out is
// not a plan either.
//
// The operator is trusted by construction: they hold the admin key this run
// installs. Exempting the address they are converging from removes a trap
// the tool would otherwise set for itself. Addresses accumulate across runs,
// so converging from a second workstation does not evict the first.

// LoopbackIgnoreIP is what the jail exempts when no operator address is
// known: a console or cloud-init run has no SSH peer to trust.
const LoopbackIgnoreIP = "127.0.0.1/8 ::1"

// ParseOperatorIP returns the peer address carried by an SSH_CONNECTION
// value ("<client ip> <client port> <server ip> <server port>"), or "" when
// the value is absent or does not start with one parseable address.
func ParseOperatorIP(sshConnection string) string {
	first, _, _ := strings.Cut(strings.TrimSpace(sshConnection), " ")
	addr, err := netip.ParseAddr(first)
	if err != nil || !addr.IsValid() {
		return ""
	}
	// A loopback or unspecified peer adds nothing: the constant already
	// covers it, and 0.0.0.0 in an ignoreip would exempt the whole internet.
	if addr.IsLoopback() || addr.IsUnspecified() {
		return ""
	}
	return addr.Unmap().String()
}

// MergeIgnoreIP returns the ignoreip value for the jail: the addresses
// already exempted by a jail this tool wrote, plus loopback, plus ip when it
// is not already listed. Order is stable so a re-run rewrites the same
// bytes and the golden does not churn.
func MergeIgnoreIP(existingJail, ip string) string {
	out := []string{}
	seen := map[string]bool{}
	add := func(token string) {
		if token == "" || seen[token] {
			return
		}
		seen[token] = true
		out = append(out, token)
	}
	for _, token := range strings.Fields(LoopbackIgnoreIP) {
		add(token)
	}
	for _, token := range strings.Fields(existingIgnoreIP(existingJail)) {
		add(token)
	}
	add(ip)
	return strings.Join(out, " ")
}

// existingIgnoreIP collects EVERY ignoreip value in the text, "" when it
// carries none. Every one, not the first: the caller may hand over several
// concatenated jail fragments, and keeping only one would drop the exemptions
// the others hold.
func existingIgnoreIP(jail string) string {
	var found []string
	for _, line := range strings.Split(jail, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok && strings.TrimSpace(key) == "ignoreip" {
			found = append(found, strings.TrimSpace(value))
		}
	}
	return strings.Join(found, " ")
}

// ProcTable is the /proc surface DetectOperatorIP walks, injected so the
// walk can be proven without a real process tree.
type ProcTable struct {
	// Self is the pid the walk starts from.
	Self int
	// PPid returns the parent of pid.
	PPid func(pid int) (int, error)
	// Environ returns the NUL-separated environment of pid.
	Environ func(pid int) (string, error)
}

// DetectOperatorIP finds the address of the SSH session this process
// descends from.
//
// It cannot simply read $SSH_CONNECTION: `up` re-executes itself through
// sudo (cmd/edge-setup/main.go), and sudo's env_reset drops the variable
// before the privileged process ever starts. Depending on an env_keep entry
// would make the exemption a property of the host's sudoers rather than of
// this tool. So the walk climbs the parent chain: sudo, then the login
// shell, then sshd, and takes the first SSH_CONNECTION it finds; as root,
// every /proc/<pid>/environ on that chain is readable.
//
// Returns "" for a console, cloud-init or local run: there is no peer to
// exempt, and inventing one would be worse than exempting nothing.
func DetectOperatorIP(p ProcTable) string {
	pid := p.Self
	// The chain is sudo → shell → sshd → sshd (privsep) → init; 16 hops is
	// far past that and terminates on a mislinked or looping table.
	for hop := 0; hop < 16 && pid > 1; hop++ {
		environ, err := p.Environ(pid)
		if err == nil {
			for _, entry := range strings.Split(environ, "\x00") {
				name, value, found := strings.Cut(entry, "=")
				if found && name == "SSH_CONNECTION" {
					if ip := ParseOperatorIP(value); ip != "" {
						return ip
					}
				}
			}
		}
		parent, err := p.PPid(pid)
		if err != nil || parent == pid {
			return ""
		}
		pid = parent
	}
	return ""
}

// HostProcTable reads the real /proc.
func HostProcTable() ProcTable {
	return ProcTable{
		Self:    os.Getpid(),
		PPid:    procPPid,
		Environ: func(pid int) (string, error) { return readFileString(procPath(pid, "environ")) },
	}
}

func procPath(pid int, name string) string {
	return fmt.Sprintf("/proc/%d/%s", pid, name)
}

func readFileString(path string) (string, error) {
	b, err := os.ReadFile(path)
	return string(b), err
}

// procPPid reads field 4 of /proc/<pid>/stat. The comm field (2) may itself
// contain spaces and parentheses, so the scan starts after its LAST ')'.
func procPPid(pid int) (int, error) {
	stat, err := readFileString(procPath(pid, "stat"))
	if err != nil {
		return 0, err
	}
	close := strings.LastIndex(stat, ")")
	if close < 0 {
		return 0, fmt.Errorf("%s: no comm field", procPath(pid, "stat"))
	}
	fields := strings.Fields(stat[close+1:])
	// fields[0] is state, fields[1] is ppid.
	if len(fields) < 2 {
		return 0, fmt.Errorf("%s: truncated", procPath(pid, "stat"))
	}
	return strconv.Atoi(fields[1])
}
