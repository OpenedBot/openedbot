package hardening

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// SSHDEffective parses `sshd -T` into lowercase key → value.
func SSHDEffective(out string) map[string]string {
	kv := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), " ")
		if ok {
			kv[strings.ToLower(k)] = strings.TrimSpace(v)
		}
	}
	return kv
}

// RequireSSHDHardened checks the effective sshd policy for the admin user.
func RequireSSHDHardened(effective map[string]string, adminUser string) error {
	want := map[string]string{
		"allowusers":                   adminUser,
		"permitrootlogin":              "no",
		"passwordauthentication":       "no",
		"kbdinteractiveauthentication": "no",
		"authenticationmethods":        "publickey",
	}
	for k, v := range want {
		if effective[k] != v {
			return fmt.Errorf("sshd -T: %s = %q, want %q", k, effective[k], v)
		}
	}
	return nil
}

var fingerprintRe = regexp.MustCompile(`SHA256:[A-Za-z0-9+/]{43}`)

// Fingerprints extracts the SHA256 fingerprints of `ssh-keygen -lf` output,
// one per key line.
func Fingerprints(out string) []string {
	var fps []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		if m := fingerprintRe.FindString(line); m != "" {
			fps = append(fps, m)
		}
	}
	return fps
}

// ContainsFingerprint reports whether want is one of the fingerprints
// returned by Fingerprints. An empty want never matches.
func ContainsFingerprint(fps []string, want string) bool {
	if want == "" {
		return false
	}
	for _, fp := range fps {
		if fp == want {
			return true
		}
	}
	return false
}

// UFWAllowedInPorts returns the sorted unique targets with an inbound ALLOW
// or LIMIT rule in `ufw status` output (both IPv4 and v6 lines). LIMIT still
// permits traffic and must therefore be declared by the host owner.
func UFWAllowedInPorts(status string) []string {
	seen := map[string]bool{}
	for _, line := range strings.Split(status, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		switch {
		case (f[1] == "ALLOW" || f[1] == "LIMIT") && f[2] != "OUT":
			seen[f[0]] = true
		case f[1] == "(v6)" && len(f) >= 4 && (f[2] == "ALLOW" || f[2] == "LIMIT") && f[3] != "OUT":
			seen[f[0]] = true
		}
	}
	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// UFWOnlyManagedRules reports whether every rule line of `ufw status`
// carries the Hermes-managed comment: the firewall is then ours to replay.
func UFWOnlyManagedRules(status string) bool {
	rules := 0
	for _, line := range strings.Split(status, "\n") {
		if !strings.Contains(line, " ALLOW ") && !strings.Contains(line, " LIMIT ") && !strings.Contains(line, " DENY ") {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(line), "To ") {
			continue
		}
		rules++
		if !strings.Contains(line, "Hermes-managed") {
			return false
		}
	}
	return rules > 0
}

// UFWStatusActive reports "Status: active".
func UFWStatusActive(status string) bool { return strings.Contains(status, "Status: active") }

// UFWDeniesOut reports whether `ufw status` shows DENY OUT for a network.
func UFWDeniesOut(status, network string) bool {
	re := regexp.MustCompile(regexp.QuoteMeta(network) + `\s+DENY OUT`)
	return re.MatchString(status)
}

// UFWHasHistoricalRules reports lines starting with "ufw " in `ufw show added`.
func UFWHasHistoricalRules(showAdded string) bool {
	for _, line := range strings.Split(showAdded, "\n") {
		if strings.HasPrefix(line, "ufw ") {
			return true
		}
	}
	return false
}

// RequireExactPorts checks the allowed inbound ports are exactly the wanted
// TCP ports.
func RequireExactPorts(allowed []string, ports []int) error {
	want := make([]string, 0, len(ports))
	for _, p := range ports {
		want = append(want, fmt.Sprintf("%d/tcp", p))
	}
	sort.Strings(want)
	if strings.Join(allowed, " ") != strings.Join(want, " ") {
		return fmt.Errorf("UFW allows %v inbound, want exactly %v", allowed, want)
	}
	return nil
}

// RequireExactRules checks the complete declared inbound PORT/proto policy.
func RequireExactRules(allowed, rules []string) error {
	want := append([]string{}, rules...)
	sort.Strings(want)
	got := append([]string{}, allowed...)
	sort.Strings(got)
	if strings.Join(got, " ") != strings.Join(want, " ") {
		return fmt.Errorf("UFW allows %v inbound, want exactly %v", got, want)
	}
	return nil
}

// RequireAllowedSubset refuses an existing inbound allowance that the
// operator did not declare, while allowing HVS to add missing declarations.
func RequireAllowedSubset(allowed, declared []string) error {
	want := make(map[string]bool, len(declared))
	for _, rule := range declared {
		want[rule] = true
	}
	var foreign []string
	for _, rule := range allowed {
		if !want[rule] {
			foreign = append(foreign, rule)
		}
	}
	if len(foreign) > 0 {
		sort.Strings(foreign)
		return fmt.Errorf("UFW already allows undeclared inbound rules %v; declare them with --allow-inbound or reconcile them manually", foreign)
	}
	return nil
}

// IptablesInputDrop reports "-P INPUT DROP" in `iptables -S`.
func IptablesInputDrop(out string) bool {
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "-P INPUT DROP" {
			return true
		}
	}
	return false
}

// ListenerOnPort reports whether `ss -H -ltnup` shows a listener on :port.
func ListenerOnPort(ss string, port int) bool {
	re := regexp.MustCompile(fmt.Sprintf(`:%d(\s|$)`, port))
	return re.MatchString(ss)
}

// PublicListener reports a wildcard listener on the port in `ss -H -ltn`.
func PublicListener(ss string, port int) bool {
	re := regexp.MustCompile(fmt.Sprintf(`(^|\s)(0\.0\.0\.0|\*|\[::\]):%d(\s|$)`, port))
	return re.MatchString(ss)
}

// LoopbackListener reports a loopback listener on the port.
func LoopbackListener(ss string, port int) bool {
	re := regexp.MustCompile(fmt.Sprintf(`(127\.0\.0\.1|\[::1\]):%d(\s|$)`, port))
	return re.MatchString(ss)
}

// PAMGate inspects /etc/pam.d/common-password: pam_pwquality must be loaded
// exactly, without arguments that would override the managed policy and
// without an ambiguous line continuation. Returns nil or the reason.
func PAMGate(commonPassword string) error {
	found, override, continuation := false, false, false
	pw := regexp.MustCompile(`^\s*password\s.*pam_pwquality\.so(\s|$)`)
	ov := regexp.MustCompile(`(^|\s)(conf|minlen|dcredit|ucredit|lcredit|ocredit|enforcing)\s*=`)
	for _, line := range strings.Split(commonPassword, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if pw.MatchString(line) {
			found = true
			if strings.HasSuffix(strings.TrimRight(line, " \t"), `\`) {
				continuation = true
			}
			if ov.MatchString(line) {
				override = true
			}
		}
	}
	switch {
	case !found:
		return fmt.Errorf("common-password does not load pam_pwquality")
	case override:
		return fmt.Errorf("common-password overrides pam_pwquality arguments; module arguments win over managed files")
	case continuation:
		return fmt.Errorf("common-password has an ambiguous line continuation on the pam_pwquality line")
	}
	return nil
}

// PwqualityOptions reads the managed options of one pwquality file.
func PwqualityOptions(content string) map[string]string {
	kv := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, ";") {
			continue
		}
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			continue
		}
		k = strings.ToLower(strings.TrimSpace(k))
		v = strings.TrimSpace(strings.SplitN(v, "#", 2)[0])
		switch k {
		case "minlen", "dcredit", "ucredit", "lcredit", "ocredit", "enforcing":
			kv[k] = v
		}
	}
	return kv
}

// PwqualityFile is one policy file in precedence order.
type PwqualityFile struct {
	Name    string
	Content string
}

// EffectivePwquality applies the real precedence: drop-ins from
// /usr/lib and /etc merged by basename and sorted, then pwquality.conf
// (/etc if present else /usr/lib) last.
func EffectivePwquality(dropins map[string]string, mainConf string) map[string]string {
	names := make([]string, 0, len(dropins))
	for n := range dropins {
		names = append(names, n)
	}
	sort.Strings(names)
	eff := map[string]string{}
	for _, n := range names {
		for k, v := range PwqualityOptions(dropins[n]) {
			eff[k] = v
		}
	}
	for k, v := range PwqualityOptions(mainConf) {
		eff[k] = v
	}
	return eff
}

// RequirePwquality checks the effective policy and the enforce_for_root line
// of the managed drop-in.
func RequirePwquality(effective map[string]string, managedDropin string, minLen int) error {
	want := map[string]string{"minlen": fmt.Sprint(minLen), "dcredit": "0", "ucredit": "0", "lcredit": "0", "ocredit": "0", "enforcing": "1"}
	for k, v := range want {
		if effective[k] != v {
			return fmt.Errorf("effective pwquality %s = %q, want %q", k, effective[k], v)
		}
	}
	efr := regexp.MustCompile(`(?m)^\s*enforce_for_root(\s*(#.*)?)?$`)
	if !efr.MatchString(managedDropin) {
		return fmt.Errorf("the managed pwquality drop-in lacks enforce_for_root")
	}
	return nil
}

// PwqualityOverridesPresent lists files carrying a managed option (used
// before install: a pre-existing active policy would win over ours).
func PwqualityOverridesPresent(files map[string]string) []string {
	var out []string
	for name, content := range files {
		if len(PwqualityOptions(content)) > 0 {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// SudoersActiveLines returns non-empty, non-comment lines of a sudoers file.
func SudoersActiveLines(content string) []string {
	var out []string
	for _, line := range strings.Split(content, "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "#") && (len(t) == 1 || strings.HasPrefix(t, "# ") || strings.HasPrefix(t, "#\t")) {
			continue
		}
		if strings.HasPrefix(t, "#") && !strings.HasPrefix(t, "#include") {
			continue
		}
		out = append(out, t)
	}
	return out
}

// HasGroup reports membership.
func HasGroup(groups []string, g string) bool {
	for _, x := range groups {
		if x == g {
			return true
		}
	}
	return false
}

// PasswordLocked reports "L" in `passwd -S`.
func PasswordLocked(out string) bool {
	f := strings.Fields(out)
	return len(f) >= 2 && f[1] == "L"
}

// AcceptedPublickey scans sshd journal lines for an accepted publickey login
// of user with the fingerprint, and reports any accepted password or root
// login as a defect.
func AcceptedPublickey(journal, user, fingerprint string) (ok bool, defect string) {
	for _, line := range strings.Split(journal, "\n") {
		if strings.Contains(line, "Accepted password") {
			return false, "a password login was accepted after the lockdown"
		}
		if strings.Contains(line, "Accepted publickey for root ") || strings.Contains(line, "Accepted keyboard-interactive") {
			return false, "a root or keyboard-interactive login was accepted after the lockdown"
		}
		if strings.Contains(line, "Accepted publickey for "+user+" ") && strings.Contains(line, fingerprint) {
			ok = true
		}
	}
	return ok, ""
}

// LoopbackGuardPorts are the private loopback listeners (gateway, Dashboard)
// that only the service user and root may open. Every other uid on the host
// (the SSH administrator without sudo, the quarantined cloud-init account, a
// compromised third-party service) is rejected before the connection exists,
// so a run created outside the connector link needs root, not just a shell.
var LoopbackGuardPorts = []int{8642, 9119}

// LoopbackGuardRules returns the iptables OUTPUT rule specifications, in
// insertion order for `-I OUTPUT 1` (the LAST returned rule ends up first):
// a REJECT for every port, then an ACCEPT per allowed uid above it. Loopback
// only, IPv4 only: the gateway binds 127.0.0.1 and nothing listens on ::1.
func LoopbackGuardRules(uids []int, ports []int) [][]string {
	var rules [][]string
	for _, port := range ports {
		rules = append(rules, []string{"-o", "lo", "-p", "tcp", "-m", "tcp", "--dport", strconv.Itoa(port), "-j", "REJECT", "--reject-with", "icmp-port-unreachable"})
	}
	for _, port := range ports {
		for _, uid := range uids {
			rules = append(rules, []string{"-o", "lo", "-p", "tcp", "-m", "tcp", "--dport", strconv.Itoa(port), "-m", "owner", "--uid-owner", strconv.Itoa(uid), "-j", "ACCEPT"})
		}
	}
	return rules
}

// IptablesLoopbackGuarded reports, from `iptables -S OUTPUT`, that every
// port carries its REJECT and that each allowed uid has its ACCEPT ABOVE that
// REJECT. An ACCEPT below the REJECT is dead, so it does not count.
func IptablesLoopbackGuarded(out string, uids []int, ports []int) bool {
	lines := strings.Split(out, "\n")
	for _, port := range ports {
		reject := -1
		for i, line := range lines {
			if isLoopbackRule(line, port) && strings.Contains(line, " -j REJECT") {
				reject = i
				break
			}
		}
		if reject < 0 {
			return false
		}
		for _, uid := range uids {
			found := false
			for _, line := range lines[:reject] {
				if isLoopbackRule(line, port) && strings.Contains(line, " -m owner --uid-owner "+strconv.Itoa(uid)+" -j ACCEPT") {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
	}
	return true
}

func isLoopbackRule(line string, port int) bool {
	line = strings.TrimSpace(line)
	return strings.HasPrefix(line, "-A OUTPUT ") && strings.Contains(line, " -o lo ") && strings.Contains(line, " --dport "+strconv.Itoa(port)+" ")
}
