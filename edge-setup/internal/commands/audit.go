package commands

import (
	"fmt"

	"github.com/OpenedBot/openedbot/edge-setup/internal/audit"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/term"
)

func runAudit(env cli.Env, args []string) int {
	fs := newFlagSet("audit", env)
	strict := fs.Bool("strict", false, "exit 1 on any FAIL or UNKNOWN")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	st, _ := state.Load()
	rep, err := audit.New(runner, st).Run(ctx)
	if err != nil {
		return fail(env, cli.ExitFailure, "audit: %v", err)
	}
	for _, r := range rep.Results {
		printf(env.Stdout, "%s", auditLine(env.Color, r))
	}
	p, w, f, u, s := rep.Counts()
	printf(env.Stdout, "%s", auditSummaryLine(env.Color, p, w, f, u, s, rep.Path))
	if *strict && !rep.Strict() {
		return cli.ExitFailure
	}
	return cli.ExitOK
}

// auditLine renders one audit result line: PASS green, WARN yellow, FAIL
// red, UNKNOWN dim; the check ID bold. It is pure so tests can check both
// the coloured and the (default) uncoloured rendering without root.
func auditLine(c term.Color, r audit.Result) string {
	return fmt.Sprintf("[%s] %s %s", statusLabel(c, r.Status, 7), c.Bold(fmt.Sprintf("%-22s", r.ID)), r.Message)
}

// auditSummaryLine renders the trailing "summary: pass=… …" line with each
// counter in its status colour.
func auditSummaryLine(c term.Color, pass, warn, fail, unknown, skip int, path string) string {
	return fmt.Sprintf("summary: %s %s %s %s %s: report %s (root-only)",
		c.Green(fmt.Sprintf("pass=%d", pass)),
		c.Yellow(fmt.Sprintf("warn=%d", warn)),
		c.Red(fmt.Sprintf("fail=%d", fail)),
		c.Dim(fmt.Sprintf("unknown=%d", unknown)),
		c.Dim(fmt.Sprintf("skip=%d", skip)),
		path)
}

func init() {
	cli.Register(cli.Command{Name: "audit", Summary: "Security inventory of the host (report is root-only)", ReadOnly: true, Run: runAudit})
}
