package hardening

import (
	"context"
	"fmt"
	"net/netip"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

// The OUT rules of `ufw status`, exactly as UFW 0.36 prints them (the columns
// are padded to 26 and 12 characters). UFW matches its rules in the order it
// lists them, the allow of a resolver included.
const (
	outAllowUDP   = "169.254.169.254 53/udp     ALLOW OUT   Anywhere                   # Hermes-managed"
	outAllowTCP   = "169.254.169.254 53/tcp     ALLOW OUT   Anywhere                   # Hermes-managed"
	outDenyV4     = "169.254.0.0/16             DENY OUT    Anywhere                   # Hermes-managed"
	outAllowV6UDP = "fd00:ec2::253 53/udp       ALLOW OUT   Anywhere (v6)              # Hermes-managed"
	outAllowV6TCP = "fd00:ec2::253 53/tcp       ALLOW OUT   Anywhere (v6)              # Hermes-managed"
	outDenyV6     = "fd00:ec2::/64              DENY OUT    Anywhere (v6)              # Hermes-managed"
)

// ufwStatusOf renders `ufw status` (verbose or not) of a host whose only
// inbound rule is 22/tcp: the inbound rules, a blank line, then out in order.
func ufwStatusOf(verbose bool, out ...string) string {
	head, inbound := "Status: active\n", "ALLOW      "
	if verbose {
		head += "Logging: on (low)\nDefault: deny (incoming), allow (outgoing), deny (routed)\nNew profiles: skip\n"
		inbound = "ALLOW IN   "
	}
	return head + "\nTo                         Action      From\n--                         ------      ----\n" +
		"22/tcp                     " + inbound + " Anywhere                   # Hermes-managed\n" +
		"22/tcp (v6)                " + inbound + " Anywhere (v6)              # Hermes-managed\n\n" +
		strings.Join(out, "\n") + "\n"
}

// resolverHost is a hardener over a fake runner, on a host that has ufw, whose
// /etc/resolv.conf names etc and whose systemd-resolved keeps upstream ("" is
// no file). Logged collects what it tells the operator.
func resolverHost(t *testing.T, etc, upstream string) (h *Hardener, fake *exectest.Fake, logged *[]string) {
	t.Helper()
	dir := t.TempDir()
	files := []string{filepath.Join(dir, "resolv.conf"), filepath.Join(dir, "resolved.conf")}
	for i, content := range []string{etc, upstream} {
		if content == "" {
			continue
		}
		if err := os.WriteFile(files[i], []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fake = exectest.NewFake()
	fake.Default = &exec.Result{}
	logged = new([]string)
	h = New(fake, func(format string, args ...any) { *logged = append(*logged, fmt.Sprintf(format, args...)) })
	h.ResolverFiles = files
	h.UFWInstalled = func() bool { return true }
	return h, fake, logged
}

// ufwOf is the guarded ufw mutation Enforce hands to denyMetadataEgress.
func ufwOf(h *Hardener) func(args ...string) error {
	return func(args ...string) error {
		_, err := exec.Must(context.Background(), h.Runner, exec.Cmd{Path: "/usr/sbin/ufw", Args: args})
		return err
	}
}

// enforceEgress runs what the firewall branch of Enforce runs for the deny out
// rules, over status as `ufw status verbose` printed it beforehand.
func enforceEgress(h *Hardener, status string) error {
	resolvers, err := h.metadataResolvers()
	if err != nil {
		return err
	}
	return h.denyMetadataEgress(status, resolvers, ufwOf(h))
}

const (
	cmdAllowUDP   = "/usr/sbin/ufw prepend allow out to 169.254.169.254 port 53 proto udp comment Hermes-managed"
	cmdAllowTCP   = "/usr/sbin/ufw prepend allow out to 169.254.169.254 port 53 proto tcp comment Hermes-managed"
	cmdAllowV6UDP = "/usr/sbin/ufw prepend allow out to fd00:ec2::253 port 53 proto udp comment Hermes-managed"
	cmdAllowV6TCP = "/usr/sbin/ufw prepend allow out to fd00:ec2::253 port 53 proto tcp comment Hermes-managed"
	cmdDenyV4     = "/usr/sbin/ufw deny out to 169.254.0.0/16 comment Hermes-managed"
	cmdDenyV6     = "/usr/sbin/ufw deny out to fd00:ec2::/64 comment Hermes-managed"
)

// dryRun is the preflight form of an allow command.
func dryRun(command string) string {
	return strings.Replace(command, "ufw prepend", "ufw --dry-run prepend", 1)
}

func requireCommands(t *testing.T, fake *exectest.Fake, want ...string) {
	t.Helper()
	if got := strings.Join(fake.Commands(), "\n"); got != strings.Join(want, "\n") {
		t.Errorf("commands:\n%s\nwant:\n%s", got, strings.Join(want, "\n"))
	}
}

// A resolver inside a denied range keeps DNS: its allow rules are added before
// the deny of the range, so the host-wide deny cannot cut name resolution.
func TestEnforceAllowsDNSToALinkLocalResolverBeforeTheDeny(t *testing.T) {
	h, fake, logged := resolverHost(t, "search c.example.internal\nnameserver 169.254.169.254\n", "")
	if err := enforceEgress(h, "Status: inactive\n"); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake, cmdAllowUDP, cmdAllowTCP, cmdDenyV4, cmdDenyV6)
	if len(*logged) != 1 || !strings.Contains((*logged)[0], "169.254.169.254") || !strings.Contains((*logged)[0], "udp and tcp") {
		t.Errorf("the exception must be told once, got %q", *logged)
	}
}

// With the stub in /etc/resolv.conf the real resolver is the upstream that
// systemd-resolved lists: UFW filters its queries too.
func TestEnforceReadsTheUpstreamsBehindTheSystemdResolvedStub(t *testing.T) {
	h, fake, _ := resolverHost(t, "nameserver 127.0.0.53\noptions edns0 trust-ad\n", "nameserver 169.254.169.254\nsearch c.example.internal\n")
	if err := enforceEgress(h, "Status: inactive\n"); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake, cmdAllowUDP, cmdAllowTCP, cmdDenyV4, cmdDenyV6)

	// Named by both files, it is one exception.
	h, fake, _ = resolverHost(t, "nameserver 169.254.169.254\n", "nameserver 169.254.169.254\n")
	if err := enforceEgress(h, "Status: inactive\n"); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake, cmdAllowUDP, cmdAllowTCP, cmdDenyV4, cmdDenyV6)
}

func TestEnforceAllowsDNSToAnIPv6ResolverBeforeItsDeny(t *testing.T) {
	h, fake, _ := resolverHost(t, "nameserver fd00:ec2::253\n", "")
	if err := enforceEgress(h, "Status: inactive\n"); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake, cmdDenyV4, cmdAllowV6UDP, cmdAllowV6TCP, cmdDenyV6)
}

// Every resolver of a range gets its own exception, all of them before the one
// deny of that range.
func TestEnforceAllowsEveryResolverOfARangeBeforeItsDeny(t *testing.T) {
	h, fake, _ := resolverHost(t, "nameserver 169.254.169.254\nnameserver 169.254.169.253\n", "")
	if err := enforceEgress(h, "Status: inactive\n"); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake, cmdAllowUDP, cmdAllowTCP,
		"/usr/sbin/ufw prepend allow out to 169.254.169.253 port 53 proto udp comment Hermes-managed",
		"/usr/sbin/ufw prepend allow out to 169.254.169.253 port 53 proto tcp comment Hermes-managed",
		cmdDenyV4, cmdDenyV6)
}

// Without a resolver in a denied range the policy is what it always was: two
// deny rules, nothing else, whatever the files say.
func TestEnforceLeavesTheDenyRulesAloneWithoutALinkLocalResolver(t *testing.T) {
	for name, files := range map[string][2]string{
		"no resolv.conf":          {"", ""},
		"stub only":               {"nameserver 127.0.0.53\n", ""},
		"stub, ordinary upstream": {"nameserver 127.0.0.53\n", "nameserver 1.1.1.1\nnameserver 2001:4860:4860::8888\n"},
		"link-local IPv6 scope":   {"nameserver fe80::1%eth0\n", ""},
	} {
		h, fake, logged := resolverHost(t, files[0], files[1])
		if err := enforceEgress(h, "Status: inactive\n"); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		requireCommands(t, fake, cmdDenyV4, cmdDenyV6)
		if len(*logged) != 0 {
			t.Errorf("%s: nothing to tell, got %q", name, *logged)
		}
	}
}

// A replayed Enforce adds nothing it already holds.
func TestEnforceIsIdempotent(t *testing.T) {
	h, fake, logged := resolverHost(t, "nameserver 169.254.169.254\nnameserver fd00:ec2::253\n", "")
	status := ufwStatusOf(true, outAllowTCP, outAllowUDP, outDenyV4, outAllowV6TCP, outAllowV6UDP, outDenyV6)
	if err := enforceEgress(h, status); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake)
	if len(*logged) != 0 {
		t.Errorf("a policy already in place is not told again, got %q", *logged)
	}
}

// A host that carries the deny first (an earlier build, or an operator) gets
// the exception above it: `prepend`, never an append behind the deny.
func TestEnforcePutsTheExceptionAboveADenyAlreadyThere(t *testing.T) {
	h, fake, _ := resolverHost(t, "nameserver 169.254.169.254\n", "")
	if err := enforceEgress(h, ufwStatusOf(true, outDenyV4, outDenyV6)); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake, cmdAllowUDP, cmdAllowTCP)

	// One protocol missing: only that one is added.
	h, fake, _ = resolverHost(t, "nameserver 169.254.169.254\n", "")
	if err := enforceEgress(h, ufwStatusOf(true, outAllowUDP, outDenyV4, outDenyV6)); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake, cmdAllowTCP)

	// An allow listed behind the deny never applies: UFW would not move it,
	// and the final proof reports it.
	status := ufwStatusOf(true, outDenyV4, outAllowUDP, outAllowTCP, outDenyV6)
	if ufwAllowsOutAhead(status, netip.MustParseAddr("169.254.169.254"), "53", "udp", "169.254.0.0/16") {
		t.Error("an allow listed below the deny must not count")
	}
}

// When the exception cannot be added the deny of its range is not: it would
// cut name resolution.
func TestEnforceDoesNotDenyWhatItCannotKeepReachable(t *testing.T) {
	h, fake, _ := resolverHost(t, "nameserver 169.254.169.254\n", "")
	fake.On(cmdAllowUDP, exec.Result{ExitCode: 1, Stderr: "ERROR: Invalid position '1'\n"})
	err := enforceEgress(h, "Status: inactive\n")
	if err == nil {
		t.Fatal("a failing exception must stop the policy")
	}
	for _, want := range []string{"169.254.169.254", "169.254.0.0/16", "name resolution", "Invalid position"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
	requireCommands(t, fake, cmdAllowUDP)
}

func TestEnforceRefusesWhenTheResolverFilesCannotBeRead(t *testing.T) {
	h, fake, _ := resolverHost(t, "nameserver 127.0.0.53\n", "")
	h.ResolverFiles = []string{h.ResolverFiles[0], filepath.Dir(h.ResolverFiles[0])} // a directory
	err := enforceEgress(h, "Status: inactive\n")
	if err == nil || !strings.Contains(err.Error(), "cannot be established") {
		t.Fatalf("an unreadable resolver file must refuse the firewall, got %v", err)
	}
	requireCommands(t, fake)
}

// The preflight asks UFW itself, before any access change, and changes nothing.
func TestPreflightAsksUFWToTakeTheExceptionRules(t *testing.T) {
	h, fake, _ := resolverHost(t, "nameserver 169.254.169.254\nnameserver fd00:ec2::253\n", "")
	if err := h.requireResolverException(context.Background()); err != nil {
		t.Fatal(err)
	}
	requireCommands(t, fake, dryRun(cmdAllowUDP), dryRun(cmdAllowTCP), dryRun(cmdAllowV6UDP), dryRun(cmdAllowV6TCP))
}

func TestPreflightRefusesTheFirewallUFWCannotKeepReachable(t *testing.T) {
	h, fake, _ := resolverHost(t, "nameserver fd00:ec2::253\n", "")
	fake.OnPrefix("/usr/sbin/ufw --dry-run prepend allow out to fd00:ec2::253", exec.Result{ExitCode: 1, Stderr: "ERROR: Adding IPv6 rule failed: IPv6 not enabled\n"})
	err := h.requireResolverException(context.Background())
	if err == nil {
		t.Fatal("the firewall must be refused")
	}
	for _, want := range []string{"fd00:ec2::253", "fd00:ec2::/64", "refusing to enable the firewall", "name resolution", "IPv6 not enabled"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
	for _, command := range fake.Commands() {
		if !strings.Contains(command, "--dry-run") {
			t.Errorf("the preflight changed something: %s", command)
		}
	}

	// A dry run prints the whole rule file on stdout: that is no reason.
	h, fake, _ = resolverHost(t, "nameserver 169.254.169.254\n", "")
	fake.OnPrefix("/usr/sbin/ufw --dry-run", exec.Result{ExitCode: 1, Stdout: "*filter\n### RULES ###\nCOMMIT\n"})
	if err := h.requireResolverException(context.Background()); err == nil || strings.Contains(err.Error(), "COMMIT") || !strings.Contains(err.Error(), "exit 1") {
		t.Errorf("the refusal must give UFW's exit code, not its output, got %v", err)
	}
}

// A resolver file that cannot be read refuses the firewall before Prepare takes
// its first snapshot or runs its first command: nothing is left to recover from.
func TestPrepareRefusesUnreadableResolverFilesBeforeAnySnapshot(t *testing.T) {
	h, _, _ := resolverHost(t, "nameserver 127.0.0.53\n", "")
	h.ResolverFiles = []string{filepath.Dir(h.ResolverFiles[0])} // a directory
	bare := exectest.NewFake()
	root := t.TempDir()
	h.Runner = bare
	h.Guard = guard.New(filepath.Join(root, "state"), filepath.Join(root, "backup"), layout.HardeningRollbackUnit, fsx.Current(), bare)
	_, err := h.Prepare(context.Background(), Options{Features: state.Features{Firewall: true}})
	if err == nil || !strings.Contains(err.Error(), "cannot be established") {
		t.Fatalf("Prepare = %v, want the firewall refused", err)
	}
	if len(bare.Calls) != 0 {
		t.Errorf("ran %v", bare.Commands())
	}
	if h.Guard.HasSnapshot("ufw.was-active") || h.Guard.HasSnapshot("ufw.was-inactive") {
		t.Error("a snapshot was taken before the refusal")
	}
}

// No fake script and no Default: any command would fail the test.
func TestPreflightRunsNothingWithoutALinkLocalResolver(t *testing.T) {
	h, _, _ := resolverHost(t, "nameserver 127.0.0.53\n", "nameserver 8.8.8.8\n")
	bare := exectest.NewFake()
	h.Runner = bare
	if err := h.requireResolverException(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(bare.Calls) != 0 {
		t.Errorf("ran %v", bare.Commands())
	}
	h.ResolverFiles = []string{filepath.Dir(h.ResolverFiles[0])}
	if err := h.requireResolverException(context.Background()); err == nil {
		t.Error("an unreadable resolver file must refuse the firewall before any change")
	}
}

// finalizeHost is a hardener over a fake host whose UFW prints verbose and
// plain, whose iptables is default-deny and whose loopback guard is in place.
func finalizeHost(t *testing.T, etc, upstream, verbose, plain string) *Hardener {
	t.Helper()
	h, fake, _ := resolverHost(t, etc, upstream)
	h.Accounts.Lookup = func(string) (*user.User, error) {
		return &user.User{Username: "hermes", Uid: "998", Gid: "998", HomeDir: "/srv/hermes"}, nil
	}
	fake.On("/usr/sbin/ufw status verbose", exec.Result{Stdout: verbose})
	fake.On("/usr/sbin/ufw status", exec.Result{Stdout: plain})
	fake.On("/usr/sbin/iptables -S", exec.Result{Stdout: "-P INPUT DROP\n"})
	fake.On("/usr/sbin/ip6tables -S", exec.Result{Stdout: "-P INPUT DROP\n"})
	fake.On("/usr/bin/getent passwd hermes", exec.Result{Stdout: "hermes:x:998:998::/srv/hermes:/usr/sbin/nologin\n"})
	fake.On("/usr/sbin/iptables -w -S OUTPUT", exec.Result{Stdout: "-P OUTPUT ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 0 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 0 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -j REJECT --reject-with icmp-port-unreachable\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n"})
	return h
}

func finalizeFirewall(h *Hardener) error {
	return h.Finalize(context.Background(), Options{Features: state.Features{Firewall: true, AllowedInbound: []string{"22/tcp"}}}, "")
}

func fakeOf(h *Hardener) *exectest.Fake { return h.Runner.(*exectest.Fake) }

// ufwCommands keeps the ufw commands out of what a fake host ran.
func ufwCommands(fake *exectest.Fake) []string {
	var out []string
	for _, c := range fake.Commands() {
		if strings.HasPrefix(c, "/usr/sbin/ufw") {
			out = append(out, c)
		}
	}
	return out
}

func TestFinalizeAcceptsTheResolverExceptionAboveTheDeny(t *testing.T) {
	for name, c := range map[string]struct {
		etc, upstream string
		out           []string
	}{
		"IPv4 resolver":            {"nameserver 169.254.169.254\n", "", []string{outAllowTCP, outAllowUDP, outDenyV4, outDenyV6}},
		"resolver behind the stub": {"nameserver 127.0.0.53\n", "nameserver 169.254.169.254\n", []string{outAllowUDP, outAllowTCP, outDenyV4, outDenyV6}},
		"both families":            {"nameserver 169.254.169.254\nnameserver fd00:ec2::253\n", "", []string{outAllowTCP, outAllowUDP, outDenyV4, outAllowV6TCP, outAllowV6UDP, outDenyV6}},
	} {
		h := finalizeHost(t, c.etc, c.upstream, ufwStatusOf(true, c.out...), ufwStatusOf(false, c.out...))
		if err := finalizeFirewall(h); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		// In place: proven, not touched.
		if got := ufwCommands(fakeOf(h)); len(got) != 2 {
			t.Errorf("%s: a policy in place must only be read, ran %v", name, got)
		}
	}
}

// Nothing changes for a host without a resolver in a denied range: the proof
// of the two deny rules is the one it always was.
func TestFinalizeWithoutALinkLocalResolverAsksForNothingMore(t *testing.T) {
	out := []string{outDenyV4, outDenyV6}
	h := finalizeHost(t, "nameserver 127.0.0.53\n", "nameserver 1.1.1.1\n", ufwStatusOf(true, out...), ufwStatusOf(false, out...))
	if err := finalizeFirewall(h); err != nil {
		t.Fatal(err)
	}
	if got := ufwCommands(fakeOf(h)); len(got) != 2 {
		t.Errorf("only the two reads of the policy, ran %v", got)
	}
}

// A policy enforced by a build that predates the exception has the deny and
// not the exception: Finalize prepends it, then proves the order, instead of
// failing on a host that cannot resolve a name.
func TestFinalizeRestoresTheExceptionOfAPolicyEnforcedByAnOlderBuild(t *testing.T) {
	older := ufwStatusOf(true, outDenyV4, outDenyV6)
	h := finalizeHost(t, "nameserver 127.0.0.53\n", "nameserver 169.254.169.254\n", older, ufwStatusOf(false, outDenyV4, outDenyV6))
	fake := fakeOf(h)
	fake.OnSequence("/usr/sbin/ufw status verbose", exec.Result{Stdout: older},
		exec.Result{Stdout: ufwStatusOf(true, outAllowTCP, outAllowUDP, outDenyV4, outDenyV6)})
	if err := finalizeFirewall(h); err != nil {
		t.Fatalf("Finalize must repair, not fail: %v", err)
	}
	want := []string{
		"/usr/sbin/ufw status verbose", "/usr/sbin/ufw status",
		cmdAllowUDP, cmdAllowTCP, "/usr/sbin/ufw status verbose",
	}
	if got := ufwCommands(fake); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("ufw commands:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// Finalize fails only when the repair itself does: UFW refuses the rule, or
// takes it and still lists no exception above the deny.
func TestFinalizeFailsOnlyIfTheRepairFails(t *testing.T) {
	older := ufwStatusOf(true, outDenyV4, outDenyV6)
	h := finalizeHost(t, "nameserver 169.254.169.254\n", "", older, ufwStatusOf(false, outDenyV4, outDenyV6))
	fake := fakeOf(h)
	fake.On(cmdAllowUDP, exec.Result{ExitCode: 1, Stderr: "ERROR: Invalid position '1'\n"})
	err := finalizeFirewall(h)
	if err == nil {
		t.Fatal("a repair UFW refuses must fail the proof")
	}
	for _, want := range []string{"cannot restore the DNS exception", "169.254.169.254", "169.254.0.0/16", "name resolution", "Invalid position"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
	if fake.Ran(cmdAllowTCP) {
		t.Error("the repair went on after UFW refused a rule")
	}
}

// UFW skips a rule it already holds: an exception listed below the deny is not
// moved by the repair, and the proof says so instead of passing.
func TestFinalizeFailsWhenTheRepairDoesNotProduceTheOrder(t *testing.T) {
	for name, c := range map[string]struct {
		etc, upstream string
		out           []string
		want          string
	}{
		"deny without exception":      {"nameserver 169.254.169.254\n", "", []string{outDenyV4, outDenyV6}, "ufw prepend allow out to 169.254.169.254 port 53 proto udp comment Hermes-managed"},
		"upstream behind the stub":    {"nameserver 127.0.0.53\n", "nameserver 169.254.169.254\n", []string{outDenyV4, outDenyV6}, "169.254.169.254"},
		"tcp missing":                 {"nameserver 169.254.169.254\n", "", []string{outAllowUDP, outDenyV4, outDenyV6}, "proto tcp"},
		"exception below the deny":    {"nameserver 169.254.169.254\n", "", []string{outDenyV4, outAllowUDP, outAllowTCP, outDenyV6}, "ufw delete allow out to 169.254.169.254 port 53 proto udp"},
		"IPv6 resolver without allow": {"nameserver fd00:ec2::253\n", "", []string{outDenyV4, outDenyV6}, "fd00:ec2::253"},
		"another port is not DNS":     {"nameserver 169.254.169.254\n", "", []string{"169.254.169.254 80/tcp     ALLOW OUT   Anywhere                   # Hermes-managed", outAllowUDP, outDenyV4, outDenyV6}, "proto tcp"},
	} {
		// The fake host keeps answering with the same policy: the repair did not take.
		h := finalizeHost(t, c.etc, c.upstream, ufwStatusOf(true, c.out...), ufwStatusOf(false, c.out...))
		err := finalizeFirewall(h)
		if err == nil || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "above that deny") || !strings.Contains(err.Error(), "name resolution") {
			t.Errorf("%s: error %v, want one mentioning %q, the deny and name resolution", name, err, c.want)
		}
	}
}

func TestFinalizeRefusesWhenTheResolverFilesCannotBeRead(t *testing.T) {
	out := []string{outDenyV4, outDenyV6}
	h := finalizeHost(t, "nameserver 127.0.0.53\n", "", ufwStatusOf(true, out...), ufwStatusOf(false, out...))
	h.ResolverFiles = []string{filepath.Dir(h.ResolverFiles[0])}
	if err := finalizeFirewall(h); err == nil || !strings.Contains(err.Error(), "cannot be established") {
		t.Fatalf("an unreadable resolver file must fail the proof, got %v", err)
	}
}

// EnsureResolverException is what `upgrade` runs for a host whose firewall an
// older build enforced: it repairs, and a second run finds nothing to do.
func TestEnsureResolverExceptionRestoresAnOlderPolicyOnce(t *testing.T) {
	h, fake, logged := resolverHost(t, "nameserver 169.254.169.254\nnameserver fd00:ec2::253\n", "")
	older := ufwStatusOf(true, outDenyV4, outDenyV6)
	fixed := ufwStatusOf(true, outAllowTCP, outAllowUDP, outDenyV4, outAllowV6TCP, outAllowV6UDP, outDenyV6)
	fake.OnSequence("/usr/sbin/ufw status verbose", exec.Result{Stdout: older}, exec.Result{Stdout: fixed})

	changed, err := h.EnsureResolverException(context.Background())
	if err != nil || !changed {
		t.Fatalf("first run = %v, %v, want a repair", changed, err)
	}
	requireCommands(t, fake, "/usr/sbin/ufw status verbose",
		cmdAllowUDP, cmdAllowTCP, cmdAllowV6UDP, cmdAllowV6TCP, "/usr/sbin/ufw status verbose")
	if len(*logged) != 2 || !strings.Contains((*logged)[0], "169.254.169.254") || !strings.Contains((*logged)[1], "fd00:ec2::253") {
		t.Errorf("each repaired resolver is told once, got %q", *logged)
	}

	before := len(fake.Calls)
	changed, err = h.EnsureResolverException(context.Background())
	if err != nil || changed {
		t.Fatalf("second run = %v, %v, want nothing to do", changed, err)
	}
	if got := fake.Commands()[before:]; len(got) != 1 || got[0] != "/usr/sbin/ufw status verbose" {
		t.Errorf("the second run only reads the policy, ran %v", got)
	}
}

func TestEnsureResolverExceptionLeavesWhatItHasNothingToRepair(t *testing.T) {
	// No resolver inside a denied range: not a single command.
	h, _, _ := resolverHost(t, "nameserver 127.0.0.53\n", "nameserver 1.1.1.1\n")
	bare := exectest.NewFake()
	h.Runner = bare
	if changed, err := h.EnsureResolverException(context.Background()); err != nil || changed || len(bare.Calls) != 0 {
		t.Errorf("= %v, %v after %v, want nothing", changed, err, bare.Commands())
	}

	// A firewall that is not active filters nothing: only read.
	h, fake, _ := resolverHost(t, "nameserver 169.254.169.254\n", "")
	fake.On("/usr/sbin/ufw status verbose", exec.Result{Stdout: "Status: inactive\n"})
	if changed, err := h.EnsureResolverException(context.Background()); err != nil || changed {
		t.Errorf("inactive firewall = %v, %v", changed, err)
	}
	requireCommands(t, fake, "/usr/sbin/ufw status verbose")

	// A range whose deny is not in the policy gets no exception: only the
	// range that is denied is repaired.
	h, fake, _ = resolverHost(t, "nameserver 169.254.169.254\nnameserver fd00:ec2::253\n", "")
	fake.OnSequence("/usr/sbin/ufw status verbose", exec.Result{Stdout: ufwStatusOf(true, outDenyV4)},
		exec.Result{Stdout: ufwStatusOf(true, outAllowTCP, outAllowUDP, outDenyV4)})
	if changed, err := h.EnsureResolverException(context.Background()); err != nil || !changed {
		t.Fatalf("= %v, %v, want the denied range repaired", changed, err)
	}
	requireCommands(t, fake, "/usr/sbin/ufw status verbose", cmdAllowUDP, cmdAllowTCP, "/usr/sbin/ufw status verbose")

	// An unreadable resolver file stops it before any command.
	h, fake, _ = resolverHost(t, "nameserver 169.254.169.254\n", "")
	h.ResolverFiles = []string{filepath.Dir(h.ResolverFiles[0])}
	if _, err := h.EnsureResolverException(context.Background()); err == nil || !strings.Contains(err.Error(), "cannot be established") {
		t.Errorf("an unreadable resolver file = %v", err)
	}
	requireCommands(t, fake)
}

// The OUT rules of a resolver are not inbound allowances, and they carry the
// tag that lets a replay and reset recognise the firewall as this tool's.
func TestResolverExceptionRulesAreOutboundAndManaged(t *testing.T) {
	out := []string{outAllowTCP, outAllowUDP, outDenyV4, outAllowV6TCP, outAllowV6UDP, outDenyV6}
	for _, verbose := range []bool{false, true} {
		status := ufwStatusOf(verbose, out...)
		if got := strings.Join(UFWAllowedInPorts(status), " "); got != "22/tcp" {
			t.Errorf("verbose=%v: inbound allowances %q, want only 22/tcp", verbose, got)
		}
		if !UFWOnlyManagedRules(status) {
			t.Errorf("verbose=%v: every rule must carry the Hermes-managed tag", verbose)
		}
	}
}
