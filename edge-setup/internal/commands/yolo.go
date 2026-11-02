package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// `edge-setup yolo`: the host side of YOLO mode, entirely offline. `status`
// reads what each connector instance holds; `off` is the local kill switch,
// effective at once, daemon or no daemon, link or no link; `on` only lifts
// that local refusal: a host never creates a lease, openedbot grants them.

// yoloRuntimeRoot is where the Hermes profiles live (redirected by tests and
// on macOS).
var yoloRuntimeRoot = layout.RuntimeRoot

// yoloNow is the clock of the verbs (tests freeze it).
var yoloNow = time.Now

const (
	yoloApprovalPlugin = "ohb_approval_policy"
	yoloProfileFile    = "yolo.json"
)

func runYolo(env cli.Env, args []string) int {
	fs := newFlagSet("yolo", env)
	jsonOut := fs.Bool("json", false, "status: machine-readable output")
	yes := fs.Bool("yes", false, "off / on: confirm the change")
	// Les deux options sont booléennes : le verbe peut venir avant ou après
	// elles (`yolo off --yes`, comme l'écrit la doc, ou `yolo --yes off`).
	var flags, verbs []string
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			flags = append(flags, arg)
		} else {
			verbs = append(verbs, arg)
		}
	}
	if err := fs.Parse(flags); err != nil {
		return cli.ExitUsage
	}
	if len(verbs) != 1 {
		return fail(env, cli.ExitUsage, "usage: edge-setup yolo status [--json] | off --yes | on --yes")
	}
	verb := verbs[0]
	if verb != "status" && verb != "off" && verb != "on" {
		return fail(env, cli.ExitUsage, "yolo: unknown verb %q (status | off | on)", verb)
	}
	if verb != "status" && !*yes {
		what := "off refuses every YOLO lease on this host and stops the auto-approvals now"
		if verb == "on" {
			what = "on lifts the local refusal of `yolo off`; it creates no lease"
		}
		return fail(env, cli.ExitRefused, "yolo %s; add --yes (nothing was changed)", what)
	}
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	if runtime.GOOS == "darwin" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fail(env, cli.ExitFailure, "macOS user home is unavailable")
		}
		p, err := layout.MacRuntime(home)
		if err != nil {
			return fail(env, cli.ExitFailure, "macOS paths are invalid")
		}
		yoloRuntimeRoot = p.RuntimeRoot
	}
	switch verb {
	case "off":
		return yoloOff(env)
	case "on":
		return yoloOn(env)
	}
	return yoloStatus(env, *jsonOut)
}

type yoloInstanceStatus struct {
	Instance  string `json:"instance"`
	RuntimeID string `json:"runtimeId,omitempty"`
	connector.YoloHostStatus
}

func yoloStatus(env cli.Env, jsonOut bool) int {
	now := yoloNow()
	var out []yoloInstanceStatus
	for _, inst := range linkedInstances() {
		lf, err := readLinkFile(inst)
		if err != nil || lf == nil {
			out = append(out, yoloInstanceStatus{Instance: inst.Label(), YoloHostStatus: connector.YoloHostStatus{Problems: []string{fmt.Sprint(err)}}})
			continue
		}
		out = append(out, yoloInstanceStatus{Instance: inst.Label(), RuntimeID: lf.RuntimeID,
			YoloHostStatus: connector.ReadYoloStatus(stateDirOf(inst), lf.RuntimeID, lf.LeaseKeys, now)})
	}
	profiles := yoloProfileFiles()
	if jsonOut {
		data, err := json.MarshalIndent(map[string]any{"instances": out, "profilesWithLease": profiles, "at": now.Unix()}, "", "  ")
		if err != nil {
			return fail(env, cli.ExitFailure, "%v", err)
		}
		fmt.Fprintln(env.Stdout, string(data))
		return cli.ExitOK
	}
	if len(out) == 0 {
		printf(env.Stdout, "no linked connector instance: no YOLO lease can be held here")
	}
	for _, inst := range out {
		switch {
		case inst.KillProblem != "":
			printf(env.Stdout, "%s: YOLO off (%s)", inst.Instance, inst.KillProblem)
		case inst.Kill.Active():
			printf(env.Stdout, "%s: YOLO off since %s (`edge-setup yolo on --yes` to accept new leases)", inst.Instance, time.Unix(inst.Kill.KilledAt, 0).UTC().Format(time.RFC3339))
		default:
			printf(env.Stdout, "%s: %d pinned lease key(s)", inst.Instance, inst.PinnedKeys)
		}
		for _, l := range inst.Leases {
			scope := l.Scope
			if l.Profile != nil {
				scope += " " + *l.Profile
			}
			line := fmt.Sprintf("  lease %s  %-16s %s", l.LeaseID, scope, l.Status)
			if l.Status == connector.YoloActive {
				line += fmt.Sprintf(", %s left (until %s)", time.Unix(l.ExpiresAt, 0).Sub(now).Round(time.Minute), time.Unix(l.ExpiresAt, 0).UTC().Format(time.RFC3339))
			} else if l.Reason != "" {
				line += " (" + l.Reason + ")"
			}
			printf(env.Stdout, "%s", line)
		}
		if inst.PendingAudit > 0 {
			printf(env.Stdout, "  %d auto-approval(s) not yet acknowledged by openedbot", inst.PendingAudit)
		}
		for _, problem := range inst.Problems {
			printf(env.Stdout, "  problem: %s", problem)
		}
	}
	if len(profiles) > 0 {
		printf(env.Stdout, "profiles applying a lease now: %v", profiles)
	}
	return cli.ExitOK
}

// yoloProfileFiles lists the profiles whose plugin holds a yolo.json.
func yoloProfileFiles() []string {
	matches, _ := filepath.Glob(filepath.Join(yoloRuntimeRoot, "profiles", "*", "plugins", yoloApprovalPlugin, yoloProfileFile))
	var out []string
	for _, path := range matches {
		out = append(out, filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(path)))))
	}
	sort.Strings(out)
	return out
}

// yoloOff kills every lease of every instance: the kill file first (a
// running daemon reads it at every decision and within two seconds empties
// the profiles), then the profiles' yolo.json directly, so the plugin asks
// again from its very next call even when no daemon runs.
func yoloOff(env cli.Env) int {
	now := yoloNow().Unix()
	failed := false
	for _, inst := range linkedInstances() {
		dir := stateDirOf(inst)
		st, err := fsx.Lstat(dir)
		if err != nil || !st.Exists || !st.Dir || st.Symlink {
			printf(env.Stdout, "%s: no state directory yet, no lease held", inst.Label())
			continue
		}
		previous, _ := connector.ReadYoloKill(dir, yoloNow())
		kill := connector.YoloKill{KilledAt: max(now, previous.KilledAt)}
		// Owned like the directory: the daemon must read what root wrote.
		if err := connector.WriteYoloKill(dir, kill, st.Owner); err != nil {
			failed = true
			printf(env.Stderr, "%s: kill switch could not be written: %v", inst.Label(), err)
			continue
		}
		printf(env.Stdout, "%s: YOLO off; every lease issued until now is refused, and new ones until `yolo on`", inst.Label())
	}
	removed, err := removeYoloProfileFiles()
	for _, slug := range removed {
		printf(env.Stdout, "profile %s: lease file removed, its plugin asks again from the next call", slug)
	}
	if err != nil {
		failed = true
		printf(env.Stderr, "%v", err)
	}
	// Hermes' own approvals.mode was never changed for a lease and no
	// session-level yolo was enabled: there is nothing native to turn off.
	printf(env.Stdout, "a running connector applies the kill within 2 s and reports it to openedbot when the link is up")
	if failed {
		return fail(env, cli.ExitFailure, "yolo off is incomplete: see the errors above")
	}
	return cli.ExitOK
}

func removeYoloProfileFiles() ([]string, error) {
	matches, err := filepath.Glob(filepath.Join(yoloRuntimeRoot, "profiles", "*", "plugins", yoloApprovalPlugin, yoloProfileFile))
	if err != nil {
		return nil, err
	}
	var removed []string
	var failed error
	for _, path := range matches {
		slug := filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(path))))
		if err := fsx.Remove(path); err != nil {
			failed = errors.Join(failed, fmt.Errorf("profile %s: lease file could not be removed: %w", slug, err))
			continue
		}
		removed = append(removed, slug)
	}
	return removed, failed
}

// yoloOn lifts the local refusal only. Leases issued before the kill stay
// dead; the host can create none, openedbot grants the next ones.
func yoloOn(env cli.Env) int {
	now := yoloNow().Unix()
	lifted := 0
	for _, inst := range linkedInstances() {
		dir := stateDirOf(inst)
		kill, err := connector.ReadYoloKill(dir, yoloNow())
		if err == nil && !kill.Active() {
			continue
		}
		st, statErr := fsx.Lstat(dir)
		if statErr != nil || !st.Exists {
			continue
		}
		next := connector.YoloKill{KilledAt: kill.KilledAt, LiftedAt: now}
		if err := connector.WriteYoloKill(dir, next, st.Owner); err != nil {
			return fail(env, cli.ExitFailure, "%s: kill switch could not be lifted: %v", inst.Label(), err)
		}
		lifted++
		printf(env.Stdout, "%s: local refusal lifted; leases issued before %s stay refused", inst.Label(), time.Unix(kill.KilledAt, 0).UTC().Format(time.RFC3339))
	}
	if lifted == 0 {
		printf(env.Stdout, "YOLO was not off on this host: nothing to lift")
	}
	printf(env.Stdout, "this host cannot create a YOLO lease: grant one from openedbot (owner or admin)")
	return cli.ExitOK
}

func init() {
	cli.Register(cli.Command{Name: "yolo", Summary: "YOLO leases on this host, offline: status [--json], off --yes (kill switch), on --yes (lift it; creates no lease)", Run: runYolo})
}
