package commands

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

const (
	daemonReload   = "/usr/bin/systemctl daemon-reload"
	restartGateway = "/usr/bin/systemctl restart hermes-gateway"

	// previousUnit is what a host provisioned by an older release carries: the
	// metadata deny rendered next to an allow-all, which refuses nothing.
	previousUnit = "[Service]\nIPAddressAllow=any\nIPAddressDeny=169.254.0.0/16\n"
	// renderedUnit is what this binary renders instead.
	renderedUnit = "[Service]\nInaccessiblePaths=-/run/credentials\nIPAddressDeny=169.254.0.0/16\n"
	// rewordedUnit is renderedUnit as a release that only touched the comments
	// wrote it: the same directives in the same order, under other comments (both
	// markers, one indented) and an extra blank line.
	rewordedUnit = "# Gateway unit of an earlier release.\n[Service]\n  ; the credentials tree stays hidden\nInaccessiblePaths=-/run/credentials\n\n\t# metadata ranges\nIPAddressDeny=169.254.0.0/16\n"
	// rewordedAndChangedUnit is rewordedUnit with one directive that differs from
	// renderedUnit as well.
	rewordedAndChangedUnit = "# Gateway unit of an earlier release.\n[Service]\nInaccessiblePaths=-/run/credentials\nIPAddressDeny=10.0.0.0/8\n"
)

// gatewayUnitHarness is one gateway-unit step over a unit file in a temporary
// directory and a scripted systemctl, with the effects it must (not) have.
type gatewayUnitHarness struct {
	t        *testing.T
	step     gatewayUnitStep
	fake     *exectest.Fake
	path     string
	marker   string
	logged   []string
	busy     string // why the host is busy, empty when idle
	healthy  []error
	health   int // /health proofs asked
	marked   int
	markFail error
}

// newGatewayUnitHarness installs unit (when not empty) and wires the step so
// that it wants renderedUnit. Every systemctl verb succeeds unless the test
// scripts otherwise.
func newGatewayUnitHarness(t *testing.T, unit string) *gatewayUnitHarness {
	t.Helper()
	dir := t.TempDir()
	h := &gatewayUnitHarness{t: t, fake: exectest.NewFake(), path: filepath.Join(dir, "hermes-gateway.service"), marker: filepath.Join(dir, "gateway-restart-pending")}
	h.fake.Default = &exec.Result{}
	if unit != "" {
		if err := os.WriteFile(h.path, []byte(unit), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h.step = gatewayUnitStep{
		path:  h.path,
		owner: fsx.Current(),
		sd:    systemd.Client{Runner: h.fake},
		want:  func() (string, error) { return renderedUnit, nil },
		busy:  func() string { return h.busy },
		healthy: func(context.Context) error {
			h.health++
			if len(h.healthy) == 0 {
				return nil
			}
			err := h.healthy[0]
			if len(h.healthy) > 1 {
				h.healthy = h.healthy[1:]
			}
			return err
		},
		markPending: func() error {
			h.marked++
			if h.markFail != nil {
				return h.markFail
			}
			// The very marker an MCP write sets.
			return markCLIGatewayRestart(h.marker)
		},
		log: func(f string, a ...any) { h.logged = append(h.logged, fmt.Sprintf(f, a...)) },
	}
	return h
}

func (h *gatewayUnitHarness) unit() string {
	h.t.Helper()
	data, err := os.ReadFile(h.path)
	if err != nil {
		h.t.Fatal(err)
	}
	return string(data)
}

func (h *gatewayUnitHarness) commands() []string { return h.fake.Commands() }

func (h *gatewayUnitHarness) markerSet() bool {
	_, err := os.Stat(h.marker)
	return err == nil
}

// A changed unit on an idle host is written, reloaded and applied by a restart
// that is proven on /health: the same sequence `up` runs, minus its `enable`.
func TestUpgradeBringsAChangedGatewayUnitToAnIdleHost(t *testing.T) {
	h := newGatewayUnitHarness(t, previousUnit)
	res, err := h.step.apply(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != gatewayUnitRestarted {
		t.Fatalf("outcome = %v, want restarted", res.Outcome)
	}
	if got := h.unit(); got != renderedUnit {
		t.Fatalf("unit on disk:\n%s\nwant:\n%s", got, renderedUnit)
	}
	if want := []string{daemonReload, restartGateway}; !slices.Equal(h.commands(), want) {
		t.Fatalf("commands = %v, want %v", h.commands(), want)
	}
	if h.health != 1 {
		t.Fatalf("/health proven %d times, want once", h.health)
	}
	if h.marked != 0 || h.markerSet() {
		t.Fatal("an idle host restarted: no pending marker may be set")
	}
	if len(h.logged) == 0 || !strings.Contains(h.logged[len(h.logged)-1], "restarted") {
		t.Fatalf("the restart path must be logged: %v", h.logged)
	}
}

// A changed unit on a busy host is written and reloaded, but the gateway is not
// restarted under the runs: the marker an MCP write sets says a restart is
// pending, and the reason travels back for the summary.
func TestUpgradeLeavesAChangedGatewayUnitPendingOnABusyHost(t *testing.T) {
	h := newGatewayUnitHarness(t, previousUnit)
	h.busy = "2 run(s) in progress"
	res, err := h.step.apply(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != gatewayUnitPending || res.Pending != "2 run(s) in progress" {
		t.Fatalf("result = %+v, want pending for the runs", res)
	}
	if got := h.unit(); got != renderedUnit {
		t.Fatalf("the new unit must be on disk for the next start:\n%s", got)
	}
	if want := []string{daemonReload}; !slices.Equal(h.commands(), want) {
		t.Fatalf("commands = %v, want only %v: a busy host is never restarted", h.commands(), want)
	}
	if h.health != 0 {
		t.Fatal("nothing restarted, nothing to prove")
	}
	raw, err := os.ReadFile(h.marker)
	if err != nil {
		t.Fatalf("the restart-pending marker was not set: %v", err)
	}
	if _, err := time.Parse(time.RFC3339, strings.TrimSpace(string(raw))); err != nil {
		t.Fatalf("the operator reads an RFC 3339 timestamp from the marker: %q", raw)
	}
	if len(h.logged) == 0 || !strings.Contains(h.logged[len(h.logged)-1], "2 run(s) in progress") {
		t.Fatalf("the pending path and its reason must be logged: %v", h.logged)
	}
}

// A release that only rewords a comment of the template must not restart the
// gateway of every host that upgrades: the rendered text is written and
// reloaded (the file on disk is the rendered one and systemctl does not report
// it changed), and nothing else happens, on an idle host or a busy one.
func TestUpgradeDoesNotRestartTheGatewayForACommentOnlyUnitChange(t *testing.T) {
	for _, c := range []struct{ name, busy string }{{"idle host", ""}, {"busy host", "2 run(s) in progress"}} {
		t.Run(c.name, func(t *testing.T) {
			h := newGatewayUnitHarness(t, rewordedUnit)
			h.busy = c.busy
			res, err := h.step.apply(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if res.Outcome != gatewayUnitCommentOnly || res.Pending != "" {
				t.Fatalf("result = %+v, want comment-only", res)
			}
			if got := h.unit(); got != renderedUnit {
				t.Fatalf("the rendered unit must be on disk:\n%s\nwant:\n%s", got, renderedUnit)
			}
			if want := []string{daemonReload}; !slices.Equal(h.commands(), want) {
				t.Fatalf("commands = %v, want only %v: a comment never restarts the gateway", h.commands(), want)
			}
			if h.health != 0 {
				t.Fatal("nothing restarted, nothing to prove")
			}
			if h.marked != 0 || h.markerSet() {
				t.Fatal("a comment is not a pending restart: no marker may be set")
			}
			if len(h.logged) == 0 || !strings.Contains(h.logged[len(h.logged)-1], "comment-only") {
				t.Fatalf("the comment-only path must be logged: %v", h.logged)
			}
		})
	}
}

// A directive that changes next to a reworded comment is a real change, the
// comment does not excuse it: an idle host restarts on it and a busy one is
// marked, as for any other directive.
func TestUpgradeStillRestartsForADirectiveChangedBesideAComment(t *testing.T) {
	t.Run("idle host", func(t *testing.T) {
		h := newGatewayUnitHarness(t, rewordedAndChangedUnit)
		res, err := h.step.apply(context.Background())
		if err != nil || res.Outcome != gatewayUnitRestarted {
			t.Fatalf("result = %+v err = %v, want restarted", res, err)
		}
		if got := h.unit(); got != renderedUnit {
			t.Fatalf("unit on disk:\n%s\nwant:\n%s", got, renderedUnit)
		}
		if want := []string{daemonReload, restartGateway}; !slices.Equal(h.commands(), want) {
			t.Fatalf("commands = %v, want %v", h.commands(), want)
		}
		if h.health != 1 || h.marked != 0 || h.markerSet() {
			t.Fatalf("/health proven %d times, marker set = %v: want one proof and no marker", h.health, h.markerSet())
		}
	})
	t.Run("busy host", func(t *testing.T) {
		h := newGatewayUnitHarness(t, rewordedAndChangedUnit)
		h.busy = "2 run(s) in progress"
		res, err := h.step.apply(context.Background())
		if err != nil || res.Outcome != gatewayUnitPending || res.Pending != "2 run(s) in progress" {
			t.Fatalf("result = %+v err = %v, want pending for the runs", res, err)
		}
		if got := h.unit(); got != renderedUnit {
			t.Fatalf("the new unit must be on disk for the next start:\n%s", got)
		}
		if want := []string{daemonReload}; !slices.Equal(h.commands(), want) {
			t.Fatalf("commands = %v, want only %v: a busy host is never restarted", h.commands(), want)
		}
		if h.marked != 1 || !h.markerSet() {
			t.Fatalf("marker set = %v after %d attempts: the pending restart must be recorded", h.markerSet(), h.marked)
		}
	})
}

// sameUnitDirectives tells a rewording from a change: comments (first non-blank
// character `#` or `;`) and blank lines are neutral, every other line is a
// directive compared as written. Whatever it cannot tell it calls a change, so
// the caller keeps the path it always had.
func TestSameUnitDirectives(t *testing.T) {
	const unit = "[Service]\nRestart=on-failure\nEnvironment=A=#b\n"
	crlf := func(s string) string { return strings.ReplaceAll(s, "\n", "\r\n") }
	changed := strings.Replace(unit, "on-failure", "always", 1)
	for _, c := range []struct {
		name string
		a, b string
		want bool
	}{
		{"identical", unit, unit, true},
		{"comment reworded", "# one\n" + unit, "# two\n" + unit, true},
		{"comment added and removed", "[Service]\n# gone\nRestart=on-failure\nEnvironment=A=#b\n", "[Service]\nRestart=on-failure\n# new\nEnvironment=A=#b\n", true},
		{"semicolon and indented comments", "[Service]\n ; one\nRestart=on-failure\n\t# two\nEnvironment=A=#b\n", unit, true},
		{"blank lines only", "\n[Service]\n\nRestart=on-failure\n  \t\nEnvironment=A=#b\n\n", unit, true},
		{"final newline only", strings.TrimSuffix(unit, "\n"), unit, true},
		{"empty texts", "", "", true},
		{"empty against comments", "", "# only a comment\n\n", true},
		{"directive value changed", unit, changed, false},
		{"directive added", unit, unit + "RestartSec=3\n", false},
		{"directive removed", unit, "[Service]\nRestart=on-failure\n", false},
		{"directive reordered", unit, "[Service]\nEnvironment=A=#b\nRestart=on-failure\n", false},
		{"directive commented out", unit, "[Service]\n#Restart=on-failure\nEnvironment=A=#b\n", false},
		{"empty against a directive", "", unit, false},
		{"hash inside a value is not a comment", unit, strings.Replace(unit, "A=#b", "A=#c", 1), false},
		{"hash after a value is not a comment", unit, strings.Replace(unit, "on-failure", "on-failure # why", 1), false},
		{"comment and directive changed together", "# one\n" + unit, "# two\n" + changed, false},
		{"indented directive is not the same line", unit, "[Service]\n  Restart=on-failure\nEnvironment=A=#b\n", false},
		{"continued line", "[Service]\nExecStart=/bin/a \\\n  --b\n", "# reworded\n[Service]\nExecStart=/bin/a \\\n  --b\n", false},
		{"blank line after a continued line", "[Service]\nExecStart=/bin/a \\\n\nRestart=on-failure\n", "[Service]\nExecStart=/bin/a \\\nRestart=on-failure\n", false},
		{"CRLF comment reworded", crlf("# one\n" + unit), crlf("# two\n" + unit), true},
		{"CRLF against LF", crlf(unit), unit, false},
		{"CRLF directive changed", crlf(unit), crlf(changed), false},
		{"lone carriage returns", "[Service]\rRestart=on-failure\r", unit, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := sameUnitDirectives(c.a, c.b); got != c.want {
				t.Errorf("sameUnitDirectives(a, b) = %v, want %v\na: %q\nb: %q", got, c.want, c.a, c.b)
			}
			if got := sameUnitDirectives(c.b, c.a); got != c.want {
				t.Errorf("sameUnitDirectives(b, a) = %v, want %v: the comparison is symmetric", got, c.want)
			}
		})
	}
}

// A unit that already is the rendered one costs nothing: no write, no reload,
// no restart, no marker. An upgrade that finds nothing to change must not
// restart the client's gateway.
func TestUpgradeDoesNothingWhenTheGatewayUnitIsCurrent(t *testing.T) {
	h := newGatewayUnitHarness(t, renderedUnit)
	before, err := os.Stat(h.path)
	if err != nil {
		t.Fatal(err)
	}
	res, err := h.step.apply(context.Background())
	if err != nil || res.Outcome != gatewayUnitUnchanged {
		t.Fatalf("result = %+v err = %v, want unchanged", res, err)
	}
	if len(h.commands()) != 0 || h.health != 0 || h.marked != 0 {
		t.Fatalf("commands = %v, health = %d, marked = %d: nothing may run", h.commands(), h.health, h.marked)
	}
	after, err := os.Stat(h.path)
	if err != nil || !os.SameFile(before, after) || !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("an identical unit must not be rewritten")
	}
}

// A gateway that does not come back healthy on the new unit gets the previous
// unit back, reloaded and restarted, and the upgrade step is reported failed.
// The rollback reads no state: it uses the text captured before the write.
func TestUpgradeRestoresThePreviousGatewayUnitWhenHealthFails(t *testing.T) {
	h := newGatewayUnitHarness(t, previousUnit)
	h.healthy = []error{errors.New("gateway did not become healthy"), nil}
	res, err := h.step.apply(context.Background())
	if err == nil {
		t.Fatalf("a unit that fails /health must fail the step, got %+v", res)
	}
	if got := h.unit(); got != previousUnit {
		t.Fatalf("the previous unit must be back:\n%s", got)
	}
	if want := []string{daemonReload, restartGateway, daemonReload, restartGateway}; !slices.Equal(h.commands(), want) {
		t.Fatalf("commands = %v, want %v", h.commands(), want)
	}
	if h.health != 2 {
		t.Fatalf("/health asked %d times, want once on the new unit and once on the restored one", h.health)
	}
	for _, want := range []string{"did not come back on the new unit", "previous unit is back in place and the gateway answers /health on it"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not say %q", err, want)
		}
	}
	if h.markerSet() {
		t.Fatal("a failed restart is not a pending restart")
	}
}

// A restart that systemctl itself refuses (the unit fails to start under the
// new directives) is the same failure as an unhealthy gateway.
func TestUpgradeRestoresThePreviousGatewayUnitWhenTheRestartFails(t *testing.T) {
	h := newGatewayUnitHarness(t, previousUnit)
	h.fake.OnSequence(restartGateway, exec.Result{ExitCode: 1, Stderr: "Job for hermes-gateway.service failed"}, exec.Result{})
	_, err := h.step.apply(context.Background())
	if err == nil || !strings.Contains(err.Error(), "Job for hermes-gateway.service failed") {
		t.Fatalf("err = %v, want the restart failure", err)
	}
	if got := h.unit(); got != previousUnit {
		t.Fatalf("the previous unit must be back:\n%s", got)
	}
	if want := []string{daemonReload, restartGateway, daemonReload, restartGateway}; !slices.Equal(h.commands(), want) {
		t.Fatalf("commands = %v, want %v", h.commands(), want)
	}
}

// When the previous unit does not answer either, the step says so: the new unit
// is then not the only suspect.
func TestUpgradeReportsAGatewayThatIsUnhealthyOnBothUnits(t *testing.T) {
	h := newGatewayUnitHarness(t, previousUnit)
	h.healthy = []error{errors.New("no answer")}
	_, err := h.step.apply(context.Background())
	if err == nil || !strings.Contains(err.Error(), "does not answer /health on it either") {
		t.Fatalf("err = %v", err)
	}
	if got := h.unit(); got != previousUnit {
		t.Fatalf("the previous unit must be back even then:\n%s", got)
	}
}

// The rollback must still run when the pass was interrupted (^C, SIGTERM):
// the client's runtime is not left on a unit that never proved itself.
func TestUpgradeRestoresThePreviousGatewayUnitAfterACancellation(t *testing.T) {
	h := newGatewayUnitHarness(t, previousUnit)
	// systemctl under a cancelled context fails, as it does on a real host.
	h.step.sd = systemd.Client{Runner: cancellableRunner{h.fake}}
	ctx, cancel := context.WithCancel(context.Background())
	h.step.healthy = func(context.Context) error {
		h.health++
		if h.health == 1 {
			cancel()
			return context.Canceled
		}
		return nil
	}
	_, err := h.step.apply(ctx)
	if err == nil {
		t.Fatal("a cancelled proof must fail the step")
	}
	if got := h.unit(); got != previousUnit {
		t.Fatalf("the previous unit must be back after a cancellation:\n%s", got)
	}
	if want := []string{daemonReload, restartGateway, daemonReload, restartGateway}; !slices.Equal(h.commands(), want) {
		t.Fatalf("commands = %v, want %v", h.commands(), want)
	}
}

// cancellableRunner refuses to run a command once its context is spent, which
// the scripted fake does not do on its own.
type cancellableRunner struct{ exec.Runner }

func (r cancellableRunner) Run(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	if err := ctx.Err(); err != nil {
		return exec.Result{}, err
	}
	return r.Runner.Run(ctx, c)
}

// A busy host whose pending restart cannot be recorded must not keep a unit
// nobody will be told about: the previous one is put back (no restart, the
// gateway never left it) and the step fails, so the drift stays visible.
func TestUpgradeRestoresThePreviousGatewayUnitWhenThePendingMarkerCannotBeSet(t *testing.T) {
	h := newGatewayUnitHarness(t, previousUnit)
	h.busy = "a transaction is active"
	h.markFail = errors.New("gateway restart marker could not be prepared")
	_, err := h.step.apply(context.Background())
	if err == nil || !strings.Contains(err.Error(), "could not be prepared") {
		t.Fatalf("err = %v", err)
	}
	if got := h.unit(); got != previousUnit {
		t.Fatalf("the previous unit must be back:\n%s", got)
	}
	if want := []string{daemonReload, daemonReload}; !slices.Equal(h.commands(), want) {
		t.Fatalf("commands = %v, want %v: the busy gateway is never restarted", h.commands(), want)
	}
}

// An upgrade never installs the runtime: without a gateway unit there is nothing
// to bring up to date, and `up` is what writes one.
func TestUpgradeNeverCreatesTheGatewayUnit(t *testing.T) {
	h := newGatewayUnitHarness(t, "")
	res, err := h.step.apply(context.Background())
	if err != nil || res.Outcome != gatewayUnitUnchanged {
		t.Fatalf("result = %+v err = %v", res, err)
	}
	if _, err := os.Stat(h.path); !os.IsNotExist(err) {
		t.Fatalf("the unit was created: %v", err)
	}
	if len(h.commands()) != 0 {
		t.Fatalf("commands = %v", h.commands())
	}
}

// A unit `up` itself refuses to rewrite (a symlink an administrator pointed
// elsewhere) is left alone and said so.
func TestUpgradeLeavesAGatewayUnitThatIsNotARegularFile(t *testing.T) {
	h := newGatewayUnitHarness(t, "")
	target := filepath.Join(filepath.Dir(h.path), "custom.service")
	if err := os.WriteFile(target, []byte(previousUnit), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, h.path); err != nil {
		t.Fatal(err)
	}
	res, err := h.step.apply(context.Background())
	if err != nil || res.Outcome != gatewayUnitUnchanged {
		t.Fatalf("result = %+v err = %v", res, err)
	}
	if data, _ := os.ReadFile(target); string(data) != previousUnit {
		t.Fatal("the symlink target was rewritten")
	}
	if len(h.commands()) != 0 || len(h.logged) != 1 || !strings.Contains(h.logged[0], "not a regular file") {
		t.Fatalf("commands = %v, logged = %v", h.commands(), h.logged)
	}
}

// A parameter that `up` reads and an upgrade cannot derive (no state to tell
// the sandbox variant, no service account) is reported, not guessed: the unit
// stays exactly as it is.
func TestUpgradeReportsAGatewayUnitItCannotRenderInsteadOfGuessing(t *testing.T) {
	h := newGatewayUnitHarness(t, previousUnit)
	h.step.want = func() (string, error) { return "", errors.New("no state file") }
	res, err := h.step.apply(context.Background())
	if err != nil || res.Outcome != gatewayUnitUnchanged {
		t.Fatalf("result = %+v err = %v", res, err)
	}
	if got := h.unit(); got != previousUnit {
		t.Fatalf("the unit must be untouched:\n%s", got)
	}
	if len(h.commands()) != 0 || len(h.logged) != 1 || !strings.Contains(h.logged[0], "no state file") {
		t.Fatalf("commands = %v, logged = %v", h.commands(), h.logged)
	}
}

// busyReason is the signal the automatic pass defers on, shared: a run whose
// journal moved within the window and does not end on a terminal event keeps
// the host busy; a finished one, or one abandoned for longer than the window,
// does not.
func TestBusyReasonIsTheAutomaticUpgradeSignal(t *testing.T) {
	previousRoot, previousState := connectorRoot, connectorStateRoot
	connectorRoot, connectorStateRoot = t.TempDir(), t.TempDir()
	defer func() { connectorRoot, connectorStateRoot = previousRoot, previousState }()
	inst := layout.DefaultConnectorInstance
	if err := os.MkdirAll(filepath.Dir(linkPathOf(inst)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(linkPathOf(inst), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	runs := filepath.Join(stateDirOf(inst), "runs")
	j, err := connector.NewJournal(runs)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if got := runsInProgress(now); got != 0 {
		t.Fatalf("no journal: %d runs in progress", got)
	}
	if _, _, err := j.Append("running", "event: message.delta\ndata: {}", false); err != nil {
		t.Fatal(err)
	}
	if got := runsInProgress(now); got != 1 {
		t.Fatalf("runs in progress = %d, want 1", got)
	}
	if reason := busyReason(now); !strings.Contains(reason, "1 run(s) in progress") {
		t.Fatalf("busy reason = %q", reason)
	}
	// Past the window the unfinished journal is an abandoned run, not a busy host.
	if got := runsInProgress(now.Add(autoUpgradeRunWindow + time.Minute)); got != 0 {
		t.Fatalf("an abandoned run still counts: %d", got)
	}
	if _, _, err := j.Append("running", "event: run.completed\ndata: {}", true); err != nil {
		t.Fatal(err)
	}
	if got := runsInProgress(now); got != 0 {
		t.Fatalf("a finished run still counts: %d", got)
	}
}

// doctor warns, in one line with its remedy, only when the installed unit is
// positively not the rendered one.
func TestDoctorWarnsOnAStaleGatewayUnit(t *testing.T) {
	dir := t.TempDir()
	resolv := filepath.Join(dir, "resolv.conf")
	if err := os.WriteFile(resolv, []byte("nameserver 127.0.0.53\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := exectest.NewFake().On("/usr/bin/getent passwd hermes", exec.Result{Stdout: "hermes:x:998:998::/home/hermes:/usr/sbin/nologin\n"})
	accounts := account.Client{Runner: fake, Lookup: func(name string) (*user.User, error) {
		return &user.User{Username: name, Uid: "998", Gid: "998"}, nil
	}}
	st := &state.File{}
	current, err := hermes.DesiredGatewayUnit(context.Background(), accounts, st, resolv, nil)
	if err != nil {
		t.Fatal(err)
	}
	unit := filepath.Join(dir, "hermes-gateway.service")
	for _, c := range []struct {
		name  string
		unit  *string
		state *state.File
		want  string
	}{
		{"current", &current, st, ""},
		{"stale", ptr(previousUnit), st, hermes.GatewayUnitStale},
		{"missing unit is the not-active problem, not this warning", nil, st, ""},
		{"no state: cannot be told", ptr(previousUnit), nil, ""},
	} {
		_ = os.Remove(unit)
		if c.unit != nil {
			if err := os.WriteFile(unit, []byte(*c.unit), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if got := gatewayUnitWarning(context.Background(), accounts, c.state, unit, resolv); got != c.want {
			t.Errorf("%s: warning = %q, want %q", c.name, got, c.want)
		}
	}
	for _, remedy := range []string{"upgrade --yes", "up --yes"} {
		if !strings.Contains(hermes.GatewayUnitStale, remedy) {
			t.Errorf("the finding must name `%s`: %s", remedy, hermes.GatewayUnitStale)
		}
	}
}

func ptr[T any](v T) *T { return &v }
