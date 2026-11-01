package audit

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

func fixture(t *testing.T, files map[string]string) *Auditor {
	t.Helper()
	return fixtureWithRunner(t, exectest.NewFake(), files)
}

// fixtureWithRunner is fixture over a scripted runner that systemctl answers
// through as well.
func fixtureWithRunner(t *testing.T, runner *exectest.Fake, files map[string]string) *Auditor {
	t.Helper()
	root := t.TempDir()
	for p, c := range files {
		full := filepath.Join(root, p)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		_ = os.WriteFile(full, []byte(c), 0o600)
	}
	return &Auditor{Runner: runner, Systemd: systemd.Client{Runner: runner}, Root: root}
}

func TestPlatformsGate(t *testing.T) {
	a := fixture(t, map[string]string{layout.RuntimeRoot + "/.env": "TELEGRAM_BOT_TOKEN=123:abc\n"})
	if r := a.hermesPlatforms(context.Background()); r.Status != Fail {
		t.Fatalf("telegram without allowlist must FAIL: %+v", r)
	}
	a = fixture(t, map[string]string{layout.RuntimeRoot + "/.env": "TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_ALLOWED_USERS=42\n"})
	if r := a.hermesPlatforms(context.Background()); r.Status != Warn {
		t.Fatalf("telegram with allowlist is a WARN on an OHB runtime: %+v", r)
	}
	a = fixture(t, map[string]string{layout.RuntimeRoot + "/.env": "DISCORD_BOT_TOKEN=x\nGATEWAY_ALLOW_ALL_USERS=true\n"})
	if r := a.hermesPlatforms(context.Background()); r.Status != Fail {
		t.Fatalf("allow-all must FAIL: %+v", r)
	}
	a = fixture(t, map[string]string{layout.RuntimeRoot + "/.env": "OPENAI_API_KEY=x\n"})
	if r := a.hermesPlatforms(context.Background()); r.Status != Pass {
		t.Fatalf("no platform must PASS: %+v", r)
	}
}

// Regression: a deny line proves nothing while an allow entry matches first
// (systemd.resource-control(5)). A gateway unit rendered with
// IPAddressAllow=any shows `::/0 0.0.0.0/0` and used to pass this check. The one
// allow entry that may overlap a metadata range is a configured nameserver,
// allowed alone as a single host: metadata stays reachable through that
// address, which is a warning and not a failure. Any other overlap fails.
func TestMetadataEgressNeedsAnEffectiveDeny(t *testing.T) {
	const deny = "169.254.0.0/16 fd00:ec2::/64"
	const gce = "search c.example.internal\nnameserver 169.254.169.254\n"
	for _, c := range []struct {
		name, deny, allow, resolv string
		allowExit                 int
		want                      Status
		message                   string // a fragment the result must carry, if any
	}{
		{"deny and no allow list", deny, "", "nameserver 127.0.0.53\n", 0, Pass, ""},
		{"deny and an unrelated allow entry", deny, "10.0.0.0/8", "", 0, Pass, ""},
		{"allow any, as a unit rendered earlier shows it", deny, "::/0 0.0.0.0/0", "", 0, Fail, "::/0"},
		{"allow of the metadata address, not a nameserver", deny, "169.254.169.254/32", "nameserver 127.0.0.53\n", 0, Fail, "169.254.169.254/32"},
		{"allow list unreadable", deny, "", "", 1, Unknown, ""},
		{"no deny line", "", "", "", 0, Fail, ""},
		{"allow of the configured link-local nameserver", deny, "169.254.169.254/32", gce, 0, Warn, "stub"},
		{"allow of the configured IPv6 nameserver", deny, "fd00:ec2::253/128", "nameserver fd00:ec2::253\n", 0, Warn, "fd00:ec2::253"},
		{"both resolvers allowed", deny, "fd00:ec2::253/128 169.254.169.254/32", "nameserver 169.254.169.254\nnameserver fd00:ec2::253\n", 0, Warn, "169.254.169.254"},
		{"nameserver allowed next to any", deny, "::/0 0.0.0.0/0 169.254.169.254/32", gce, 0, Fail, "::/0"},
		{"nameserver allowed next to another metadata address", deny, "169.254.169.254/32 169.254.170.2/32", gce, 0, Fail, "169.254.170.2/32"},
		{"range allowed around the nameserver", deny, "169.254.0.0/16", gce, 0, Fail, "169.254.0.0/16"},
		{"allowed address that is no longer a nameserver", deny, "169.254.169.254/32", "nameserver 1.1.1.1\n", 0, Fail, "169.254.169.254/32"},
	} {
		fake := exectest.NewFake()
		show := "/usr/bin/systemctl show " + layout.GatewayUnit + " --property="
		fake.On(show+"IPAddressDeny --value", exec.Result{Stdout: c.deny + "\n"})
		fake.On(show+"IPAddressAllow --value", exec.Result{Stdout: c.allow + "\n", ExitCode: c.allowExit})
		a := fixtureWithRunner(t, fake, map[string]string{layout.ResolvConf: c.resolv})
		r := a.metadataEgress(context.Background())
		if r.Status != c.want || !strings.Contains(r.Message, c.message) {
			t.Errorf("%s: %+v, want %s mentioning %q", c.name, r, c.want, c.message)
		}
	}
}

// A gateway unit that is not the one this binary renders is a warning that names
// both remedies: the runtime works, it lacks what a newer release changed in the
// unit. The comparison uses the parameters `up` reads (the sandbox variant of the
// state, the uid of the service account, resolv.conf), so a host `up` just wrote
// passes, and what cannot be derived is UNKNOWN rather than a verdict.
func TestGatewayUnitMustBeTheOneThisBinaryRenders(t *testing.T) {
	fake := exectest.NewFake().On("/usr/bin/getent passwd hermes", exec.Result{Stdout: "hermes:x:998:998::/home/hermes:/usr/sbin/nologin\n"})
	accounts := account.Client{Runner: fake, Lookup: func(name string) (*user.User, error) {
		return &user.User{Username: name, Uid: "998", Gid: "998"}, nil
	}}
	for _, c := range []struct {
		name    string
		sandbox bool
		unit    func(want string) *string // the installed unit, nil: not installed
		noState bool
		want    Status
		message string
	}{
		{"the unit up wrote", false, func(want string) *string { return &want }, false, Pass, "is the unit this binary renders"},
		{"the sandbox unit up wrote", true, func(want string) *string { return &want }, false, Pass, "is the unit this binary renders"},
		{"an older release's unit", false, func(string) *string { u := "[Service]\nIPAddressAllow=any\n"; return &u }, false, Warn, "upgrade --yes"},
		{"the local unit on a host recorded with the sandbox", true, func(string) *string { u := "[Service]\n"; return &u }, false, Warn, "up --yes"},
		{"no unit installed", false, func(string) *string { return nil }, false, Fail, "not installed"},
		{"no state to tell the variant", false, func(want string) *string { return &want }, true, Unknown, "no state file"},
	} {
		a := fixtureWithRunner(t, fake, map[string]string{layout.ResolvConf: "nameserver 127.0.0.53\n"})
		a.Accounts = accounts
		if !c.noState {
			a.State = &state.File{Features: state.Features{Sandbox: c.sandbox}}
		}
		want, err := hermes.DesiredGatewayUnit(context.Background(), accounts, &state.File{Features: state.Features{Sandbox: c.sandbox}}, a.path(layout.ResolvConf), nil)
		if err != nil {
			t.Fatal(err)
		}
		if unit := c.unit(want); unit != nil {
			full := a.path(layout.GatewayUnitPath)
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(*unit), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		r := a.hermesGatewayUnit(context.Background())
		if r.ID != "hermes_gateway_unit" || r.Status != c.want || !strings.Contains(r.Message, c.message) {
			t.Errorf("%s: %+v, want %s mentioning %q", c.name, r, c.want, c.message)
		}
	}
}

// The check belongs to the inventory `audit` and the strict audit of `up` run:
// a unit nobody compares is a fix nobody notices is missing.
func TestRunListsTheGatewayUnitCheck(t *testing.T) {
	fake := exectest.NewFake()
	fake.Default = &exec.Result{}
	a := fixtureWithRunner(t, fake, nil)
	a.ReportTo = ""
	rep, err := a.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rep.Results {
		if r.ID == "hermes_gateway_unit" {
			if r.Status == Skip {
				t.Fatal("the gateway unit check is not optional")
			}
			return
		}
	}
	t.Fatal("hermes_gateway_unit is missing from the audit")
}

func TestSecretsModes(t *testing.T) {
	a := fixture(t, map[string]string{layout.RuntimeEnv: "API_SERVER_KEY=x\n"})
	if r := a.hermesSecrets(context.Background()); r.Status != Pass {
		t.Fatalf("%+v", r)
	}
	_ = os.Chmod(a.path(layout.RuntimeEnv), 0o644)
	if r := a.hermesSecrets(context.Background()); r.Status != Fail {
		t.Fatalf("world-readable runtime.env must FAIL: %+v", r)
	}
}

func TestMemoryAndCountsAndStrict(t *testing.T) {
	a := fixture(t, map[string]string{"/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 50 kB\n"})
	if r := a.memory(context.Background()); r.Status != Warn {
		t.Fatalf("%+v", r)
	}
	rep := Report{Results: []Result{{"a", Pass, ""}, {"b", Warn, ""}}}
	if !rep.Strict() {
		t.Fatal("warn only must be strict-ok")
	}
	rep.Results = append(rep.Results, Result{"c", Unknown, ""})
	if rep.Strict() {
		t.Fatal("unknown must block strict")
	}
}

// systemd-resolved binds 127.0.0.53 and 127.0.0.54, and `ss` writes the
// interface scope after the address. They are loopback: unreachable from
// outside whatever UFW says. Warning on them made `audit --strict` yellow
// on every correctly configured Debian host, including one this tool set
// up itself.
func TestLoopbackListenersAreNotPublic(t *testing.T) {
	for _, addr := range []string{
		"127.0.0.1", "127.0.0.53", "127.0.0.53%lo", "127.0.0.54", "127.0.0.2",
		"[::1]", "::1", "[::1]%lo",
	} {
		if !isLoopbackAddr(addr) {
			t.Errorf("%s must be treated as loopback", addr)
		}
	}
	for _, addr := range []string{
		"0.0.0.0", "*", "::", "192.0.2.10", "10.0.0.1", "[2001:db8::1]", "128.0.0.1",
	} {
		if isLoopbackAddr(addr) {
			t.Errorf("%s must NOT be treated as loopback", addr)
		}
	}
}

func TestSudoersGrantNothingToTheServiceAccount(t *testing.T) {
	withHardening := &state.File{Features: state.Features{SSHHardening: true}}
	for _, c := range []struct {
		name  string
		files map[string]string
		st    *state.File
		want  Status
	}{
		{"no drop-in", nil, nil, Pass},
		{"cloud-init rule only", map[string]string{"/etc/sudoers.d/90-cloud-init-users": "debian ALL=(ALL) NOPASSWD:ALL\n"}, nil, Pass},
		{"rule for hermes", map[string]string{"/etc/sudoers.d/zz-local": "# comment\nhermes ALL=(ALL) NOPASSWD: ALL\n"}, nil, Fail},
		{"rule for the hermes group", map[string]string{"/etc/sudoers.d/zz-local": "%hermes ALL=(root) /usr/bin/true\n"}, nil, Fail},
		{"admin rule without --ssh-hardening", map[string]string{layout.SudoersAdmin: "hermes-admin ALL=(ALL:ALL) NOPASSWD: ALL\n"}, nil, Fail},
		{"admin rule with --ssh-hardening", map[string]string{layout.SudoersAdmin: "hermes-admin ALL=(ALL:ALL) NOPASSWD: ALL\n"}, withHardening, Pass},
	} {
		a := fixture(t, c.files)
		a.State = c.st
		if r := a.sudoers(context.Background()); r.Status != c.want {
			t.Errorf("%s: %+v, want %s", c.name, r, c.want)
		}
	}
}

// privilegedFiles scans every managed tree that exists, and directories too.
func TestPrivilegedFilesScansEveryManagedTree(t *testing.T) {
	runner := exectest.NewFake()
	a := fixtureWithRunner(t, runner, map[string]string{"/etc/hermes/hermes-setup.json": "{}", layout.ToolStateDir + "/lock": ""})
	runner.OnPrefix("/usr/bin/find ", exec.Result{Stdout: a.Root + "/etc/hermes/x\n"})
	r := a.privilegedFiles(context.Background())
	if r.Status != Fail || !strings.Contains(r.Message, "/etc/hermes/x") {
		t.Fatalf("finding not reported: %+v", r)
	}
	calls := runner.Calls
	if len(calls) != 1 {
		t.Fatalf("calls %v", calls)
	}
	args := strings.Join(calls[0].Args, " ")
	for _, want := range []string{a.Root + "/etc/hermes", a.Root + layout.ToolStateDir, "-type d -perm -0002 ! -perm -1000", "-ignore_readdir_race"} {
		if !strings.Contains(args, want) {
			t.Errorf("find args %q lack %q", args, want)
		}
	}
	if strings.Contains(args, a.Root+"/srv/hermes") {
		t.Errorf("a missing tree was passed to find: %q", args)
	}
}
