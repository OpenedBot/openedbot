package hardening

import (
	"strings"
	"testing"
)

const ufwStatus = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), deny (routed)

To                         Action      From
--                         ------      ----
169.254.0.0/16             DENY OUT    Anywhere                   # Hermes-managed
22/tcp                     ALLOW       Anywhere                   # Hermes-managed
80/tcp                     ALLOW       Anywhere                   # Hermes-managed
443/tcp                    ALLOW       Anywhere                   # Hermes-managed
fd00:ec2::/64              DENY OUT    Anywhere (v6)              # Hermes-managed
22/tcp (v6)                ALLOW       Anywhere (v6)              # Hermes-managed
80/tcp (v6)                ALLOW       Anywhere (v6)              # Hermes-managed
443/tcp (v6)               ALLOW       Anywhere (v6)              # Hermes-managed
`

func TestUFWParsing(t *testing.T) {
	ports := UFWAllowedInPorts(ufwStatus)
	if strings.Join(ports, " ") != "22/tcp 443/tcp 80/tcp" {
		t.Fatalf("ports %v", ports)
	}
	if err := RequireExactPorts(ports, []int{22, 80, 443}); err != nil {
		t.Fatal(err)
	}
	if err := RequireExactPorts(ports, []int{22}); err == nil {
		t.Fatal("extra ports must be refused")
	}
	if !UFWStatusActive(ufwStatus) || !UFWDeniesOut(ufwStatus, "169.254.0.0/16") || !UFWDeniesOut(ufwStatus, "fd00:ec2::/64") {
		t.Fatal("status/deny out")
	}
	if UFWDeniesOut(ufwStatus, "10.0.0.0/8") {
		t.Fatal("false positive deny out")
	}
	if !UFWHasHistoricalRules("ufw allow 8080/tcp\n") || UFWHasHistoricalRules("Added user rules (see 'ufw status' for running firewall):\n") {
		t.Fatal("show added parsing")
	}
	if !IptablesInputDrop("-P INPUT DROP\n-P FORWARD DROP\n") || IptablesInputDrop("-P INPUT ACCEPT\n") {
		t.Fatal("iptables policy")
	}
	if err := RequireAllowedSubset([]string{"22/tcp"}, []string{"22/tcp", "443/tcp"}); err != nil {
		t.Fatalf("a declared policy may add a missing rule: %v", err)
	}
	if err := RequireAllowedSubset([]string{"22/tcp", "8080/tcp"}, []string{"22/tcp"}); err == nil {
		t.Fatal("an undeclared existing allowance must be refused")
	}
	limited := UFWAllowedInPorts("Status: active\n22/tcp LIMIT Anywhere\n22/tcp (v6) LIMIT Anywhere (v6)\n")
	if len(limited) != 1 || limited[0] != "22/tcp" {
		t.Fatalf("LIMIT is still an inbound allowance: %v", limited)
	}
}

func TestSSHDAndFingerprints(t *testing.T) {
	eff := SSHDEffective("port 22\nallowusers hermes-admin\npermitrootlogin no\npasswordauthentication no\nkbdinteractiveauthentication no\nauthenticationmethods publickey\n")
	if err := RequireSSHDHardened(eff, "hermes-admin"); err != nil {
		t.Fatal(err)
	}
	eff["permitrootlogin"] = "yes"
	if err := RequireSSHDHardened(eff, "hermes-admin"); err == nil {
		t.Fatal("root login must be refused")
	}
	fps := Fingerprints("256 SHA256:bewDJMyAPCoglP4E0mq9TROXdM2O4pQ1GFYpoSsD2n4 kev@host (ED25519)\n")
	if len(fps) != 1 || fps[0] != "SHA256:bewDJMyAPCoglP4E0mq9TROXdM2O4pQ1GFYpoSsD2n4" {
		t.Fatalf("%v", fps)
	}
	two := Fingerprints("256 SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa a (ED25519)\n256 SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb b (ED25519)\n")
	if n := len(two); n != 2 {
		t.Fatalf("two keys → %d", n)
	}
	if !ContainsFingerprint(two, "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatal("verified key must be accepted among extras")
	}
	if ContainsFingerprint(two, "SHA256:ccccccccccccccccccccccccccccccccccccccccccc") {
		t.Fatal("unknown fingerprint must not match")
	}
	if ContainsFingerprint(two, "") || ContainsFingerprint(nil, fps[0]) {
		t.Fatal("empty want or empty listing must not match")
	}
}

func TestListeners(t *testing.T) {
	ss := "LISTEN 0 4096 127.0.0.1:8642 0.0.0.0:* users:((\"hermes\",pid=1,fd=3))\nLISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 [::]:22 [::]:*\n"
	if PublicListener(ss, 8642) || !LoopbackListener(ss, 8642) || !PublicListener(ss, 22) || ListenerOnPort(ss, 5355) {
		t.Fatal("listener parsing")
	}
}

func TestPAMGate(t *testing.T) {
	if err := PAMGate("password requisite pam_pwquality.so retry=3\npassword [success=1 default=ignore] pam_unix.so obscure yescrypt\n"); err != nil {
		t.Fatal(err)
	}
	if err := PAMGate("password requisite pam_pwquality.so retry=3 minlen=8\n"); err == nil {
		t.Fatal("override must be refused")
	}
	if err := PAMGate("password requisite pam_pwquality.so retry=3 \\\n  enforce_for_root\n"); err == nil {
		t.Fatal("continuation must be refused")
	}
	if err := PAMGate("password [success=1 default=ignore] pam_unix.so\n"); err == nil {
		t.Fatal("missing module must be refused")
	}
}

func TestPwqualityPrecedence(t *testing.T) {
	managed := "# Managed by Hermes host hardening.\nminlen = 14\ndcredit = 0\nucredit = 0\nlcredit = 0\nocredit = 0\nenforcing = 1\nenforce_for_root\n"
	eff := EffectivePwquality(map[string]string{"90-hermes-hardening.conf": managed}, "# minlen = 8\n")
	if err := RequirePwquality(eff, managed, 14); err != nil {
		t.Fatal(err)
	}
	// A later drop-in (sorted after) or pwquality.conf wins: refuse.
	eff = EffectivePwquality(map[string]string{"90-hermes-hardening.conf": managed, "99-local.conf": "minlen = 6\n"}, "")
	if err := RequirePwquality(eff, managed, 14); err == nil {
		t.Fatal("a later drop-in weakening minlen must be refused")
	}
	eff = EffectivePwquality(map[string]string{"90-hermes-hardening.conf": managed}, "minlen = 6\n")
	if err := RequirePwquality(eff, managed, 14); err == nil {
		t.Fatal("pwquality.conf weakening minlen must be refused")
	}
	if got := PwqualityOverridesPresent(map[string]string{"/etc/security/pwquality.conf": "# minlen = 8\n", "/etc/security/pwquality.conf.d/local.conf": "ucredit = -1\n"}); len(got) != 1 || !strings.HasSuffix(got[0], "local.conf") {
		t.Fatalf("%v", got)
	}
}

func TestSudoersAndJournal(t *testing.T) {
	lines := SudoersActiveLines("# Created by cloud-init v. 23\n\ndebian ALL=(ALL) NOPASSWD:ALL\n")
	if len(lines) != 1 || lines[0] != "debian ALL=(ALL) NOPASSWD:ALL" {
		t.Fatalf("%v", lines)
	}
	if !PasswordLocked("debian L 09/01/2026 0 99999 7 -1") || PasswordLocked("debian P 09/01/2026 0 99999 7 -1") {
		t.Fatal("passwd -S")
	}
	ok, defect := AcceptedPublickey("Sep 01 17:00:01 h sshd[1]: Accepted publickey for hermes-admin from 198.51.100.7 port 5 ssh2: ED25519 SHA256:bewDJMyAPCoglP4E0mq9TROXdM2O4pQ1GFYpoSsD2n4\n", "hermes-admin", "SHA256:bewDJMyAPCoglP4E0mq9TROXdM2O4pQ1GFYpoSsD2n4")
	if !ok || defect != "" {
		t.Fatalf("ok=%v defect=%q", ok, defect)
	}
	if ok, defect := AcceptedPublickey("sshd[1]: Accepted password for debian from 1.2.3.4\n", "hermes-admin", "SHA256:x"); ok || defect == "" {
		t.Fatal("password login must be a defect")
	}
}

func TestSetIPv6Yes(t *testing.T) {
	if got := SetIPv6Yes("# comment\nIPV6=no\nDEFAULT_INPUT_POLICY=\"DROP\"\n"); got != "# comment\nIPV6=yes\nDEFAULT_INPUT_POLICY=\"DROP\"\n" {
		t.Fatalf("%q", got)
	}
	if got := SetIPv6Yes("X=1\n"); got != "X=1\nIPV6=yes\n" {
		t.Fatalf("%q", got)
	}
}

func TestUFWOnlyManagedRules(t *testing.T) {
	if !UFWOnlyManagedRules(ufwStatus) {
		t.Fatal("all-managed status must be recognised")
	}
	if UFWOnlyManagedRules(ufwStatus + "8080/tcp                   ALLOW       Anywhere\n") {
		t.Fatal("a foreign rule must be refused")
	}
	if UFWOnlyManagedRules("Status: active\n") {
		t.Fatal("no rule at all is not ours")
	}
}

func TestLoopbackGuardRulesAndDetection(t *testing.T) {
	rules := LoopbackGuardRules([]int{0, 998}, []int{8642, 9119})
	if len(rules) != 6 {
		t.Fatalf("rules %v", rules)
	}
	// The REJECT of each port is emitted first so that, inserted at position
	// 1 one after another, every ACCEPT lands above it.
	if strings.Join(rules[0], " ") != "-o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable" {
		t.Fatalf("first rule %v", rules[0])
	}
	if strings.Join(rules[5], " ") != "-o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 998 -j ACCEPT" {
		t.Fatalf("last rule %v", rules[5])
	}
	guarded := "-P OUTPUT ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 0 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 0 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -j REJECT --reject-with icmp-port-unreachable\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n" +
		"-A OUTPUT -j ufw-before-logging-output\n"
	if !IptablesLoopbackGuarded(guarded, []int{0, 998}, []int{8642, 9119}) {
		t.Fatal("a complete guard must be recognised")
	}
	if IptablesLoopbackGuarded(guarded, []int{0, 999}, []int{8642, 9119}) {
		t.Fatal("another uid is not the service user")
	}
	if IptablesLoopbackGuarded("-P OUTPUT ACCEPT\n-A OUTPUT -j ufw-before-logging-output\n", []int{0, 998}, []int{8642}) {
		t.Fatal("no rule is not a guard")
	}
	// An ACCEPT appended BELOW the REJECT never matches: it must not count.
	dead := "-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 0 -j ACCEPT\n"
	if IptablesLoopbackGuarded(dead, []int{0, 998}, []int{8642}) {
		t.Fatal("an ACCEPT below the REJECT is dead and must be refused")
	}
	// The REJECT alone locks root and the service user out of their own gateway.
	rejectOnly := "-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n"
	if IptablesLoopbackGuarded(rejectOnly, []int{0, 998}, []int{8642}) {
		t.Fatal("a REJECT without its ACCEPTs is a lockout, not a guard")
	}
}
