package systemd

import (
	"context"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

func client(t *testing.T) (Client, *exectest.Fake) {
	t.Helper()
	f := exectest.NewFake()
	return Client{Runner: f}, f
}

// TimerIsWaiting is the predicate every guarded mutation runs before
// touching sshd, UFW or Caddy: if it wrongly answers true, the tool mutates
// a host whose rollback will never fire. Each of the three properties must
// be able to veto on its own.
func TestTimerIsWaitingRequiresAllThreeProperties(t *testing.T) {
	const timer = "hermes-hardening-rollback.timer"
	cases := []struct {
		name                    string
		active, sub, nextElapse string
		want                    bool
	}{
		{"armed", "active", "waiting", "123456789", true},
		{"inactive", "inactive", "waiting", "123456789", false},
		{"running not waiting", "active", "running", "123456789", false},
		{"no next elapse", "active", "waiting", "0", false},
		{"next elapse n/a", "active", "waiting", "n/a", false},
		{"next elapse infinity", "active", "waiting", "infinity", false},
		{"next elapse empty", "active", "waiting", "", false},
	}
	for _, c := range cases {
		cl, f := client(t)
		f.On("/usr/bin/systemctl show "+timer+" --property=ActiveState --value", exec.Result{Stdout: c.active + "\n"})
		f.On("/usr/bin/systemctl show "+timer+" --property=SubState --value", exec.Result{Stdout: c.sub + "\n"})
		f.On("/usr/bin/systemctl show "+timer+" --property=NextElapseUSecMonotonic --value", exec.Result{Stdout: c.nextElapse + "\n"})
		got, err := cl.TimerIsWaiting(context.Background(), timer)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
		err = cl.RequireTimerWaiting(context.Background(), timer)
		if (err == nil) != c.want {
			t.Errorf("%s: RequireTimerWaiting err=%v", c.name, err)
		}
		if err != nil && !strings.Contains(err.Error(), "refusing to continue") {
			t.Errorf("%s: unhelpful refusal %q", c.name, err)
		}
	}
}

// IsActive and IsEnabled read the exit code, not the text: a unit systemd
// does not know about answers non-zero without failing the call.
func TestIsActiveAndIsEnabledReadTheExitCode(t *testing.T) {
	cl, f := client(t)
	f.On("/usr/bin/systemctl is-active --quiet caddy", exec.Result{ExitCode: 0})
	f.On("/usr/bin/systemctl is-active --quiet ghost", exec.Result{ExitCode: 3})
	f.On("/usr/bin/systemctl is-enabled --quiet caddy", exec.Result{ExitCode: 1})
	for _, c := range []struct {
		unit string
		want bool
	}{{"caddy", true}, {"ghost", false}} {
		got, err := cl.IsActive(context.Background(), c.unit)
		if err != nil || got != c.want {
			t.Errorf("IsActive(%s)=%v err=%v", c.unit, got, err)
		}
	}
	if got, err := cl.IsEnabled(context.Background(), "caddy"); err != nil || got {
		t.Errorf("IsEnabled=%v err=%v", got, err)
	}
}

// Query hands back the raw result, non-zero exit included, so callers can
// tell an expected "inactive" from a bus failure.
func TestQueryReturnsTheRawResult(t *testing.T) {
	cl, f := client(t)
	f.On("/usr/bin/systemctl is-active ghost", exec.Result{ExitCode: 3, Stdout: "inactive\n"})
	res, err := cl.Query(context.Background(), "is-active", "ghost", 0)
	if err != nil || res.ExitCode != 3 || res.Stdout != "inactive\n" {
		t.Errorf("Query=%+v err=%v", res, err)
	}
}

// The verbs must reach systemctl with their exact argv: `enable --now` in
// that order, and every unit passed through.
func TestVerbsBuildTheExpectedArgv(t *testing.T) {
	cl, f := client(t)
	f.OnPrefix("/usr/bin/systemctl", exec.Result{})
	ctx := context.Background()
	for _, call := range []struct {
		run  func() error
		want string
	}{
		{func() error { return cl.DaemonReload(ctx) }, "/usr/bin/systemctl daemon-reload"},
		{func() error { return cl.Enable(ctx, "a", "b") }, "/usr/bin/systemctl enable a b"},
		{func() error { return cl.EnableNow(ctx, "a") }, "/usr/bin/systemctl enable --now a"},
		{func() error { return cl.Disable(ctx, "a") }, "/usr/bin/systemctl disable a"},
		{func() error { return cl.Start(ctx, "a") }, "/usr/bin/systemctl start a"},
		{func() error { return cl.Stop(ctx, "a") }, "/usr/bin/systemctl stop a"},
		{func() error { return cl.Restart(ctx, "a") }, "/usr/bin/systemctl restart a"},
		{func() error { return cl.Reload(ctx, "a") }, "/usr/bin/systemctl reload a"},
		{func() error { return cl.TryRestart(ctx, "a") }, "/usr/bin/systemctl try-restart a"},
		{func() error { return cl.Mask(ctx, "a") }, "/usr/bin/systemctl mask a"},
		{func() error { return cl.Unmask(ctx, "a") }, "/usr/bin/systemctl unmask a"},
	} {
		if err := call.run(); err != nil {
			t.Fatalf("%s: %v", call.want, err)
		}
		if !f.Ran(call.want) {
			t.Errorf("missing %q; ran %v", call.want, f.Commands())
		}
	}
}

// A verb that systemctl refuses must fail loudly: the callers treat a nil
// error as "the unit is now in the state I asked for".
func TestVerbFailsOnNonZeroExit(t *testing.T) {
	cl, f := client(t)
	f.On("/usr/bin/systemctl start broken", exec.Result{ExitCode: 1, Stderr: "Job failed"})
	if err := cl.Start(context.Background(), "broken"); err == nil {
		t.Fatal("a failing systemctl start was reported as success")
	}
}

func TestListUnitFilesParsesNames(t *testing.T) {
	cl, f := client(t)
	f.On("/usr/bin/systemctl list-unit-files --no-legend --plain --no-pager hermes-*", exec.Result{
		Stdout: "hermes-gateway.service enabled enabled\nhermes-connector.service disabled -\n\n",
	})
	got, err := cl.ListUnitFiles(context.Background(), "hermes-*")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "hermes-gateway.service,hermes-connector.service" {
		t.Fatalf("got %v", got)
	}
}
