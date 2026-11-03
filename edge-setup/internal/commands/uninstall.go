package commands

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/reset"
	"golang.org/x/term"
)

// uninstallInput and uninstallIsTerminal are where the data choice is
// asked; tests replace both.
var (
	uninstallInput      io.Reader = os.Stdin
	uninstallIsTerminal           = func() bool { return term.IsTerminal(int(os.Stdin.Fd())) }
)

// purgeConfirmation is the word an operator types to destroy the data.
const purgeConfirmation = "purge"

// runUninstall is reset under the name an operator looks for, plus the
// choice reset leaves to flags: keep or purge the runtime data. Off a
// terminal that choice must come from --keep-data or --purge-data.
func runUninstall(env cli.Env, args []string) int {
	fs := newFlagSet("uninstall", env)
	var o reset.Options
	yes := fs.Bool("yes", false, "confirm the mutation")
	keep := fs.Bool("keep-data", false, "keep runtime data without asking (bearer, credentials, workspaces)")
	resetFlags(fs, &o)
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "uninstall takes no positional argument")
	}
	if *keep && o.PurgeData {
		return fail(env, cli.ExitUsage, "--keep-data and --purge-data are exclusive")
	}
	if o.PurgeData && !o.DataLossAccepted {
		return fail(env, cli.ExitRefused, "--purge-data destroys the bearer and every workspace; add --i-understand-data-loss")
	}
	if runtime.GOOS != "darwin" {
		if code := requireRoot(env); code != 0 {
			return code
		}
	}
	if !*yes && !o.Plan {
		return fail(env, cli.ExitRefused, "uninstall removes edge-setup and its runtime from this host; add --yes (or --plan to preview)")
	}
	if !*keep && !o.PurgeData && !o.Plan {
		if !uninstallIsTerminal() {
			return fail(env, cli.ExitRefused, "off a terminal, uninstall needs a data choice: add --keep-data, or --purge-data --i-understand-data-loss (nothing was changed)")
		}
		purge, err := askDataChoice(uninstallInput, env.Stderr)
		if err != nil {
			return fail(env, cli.ExitRefused, "%v (nothing was changed)", err)
		}
		o.PurgeData, o.DataLossAccepted = purge, purge
	}
	if code := retireBeforeUninstall(env, o.Plan); code != 0 {
		return code
	}
	if runtime.GOOS == "darwin" {
		return runMacReset(env, o, *yes, "uninstall")
	}
	done := "uninstall complete: no hermes-* unit, path or edge-setup command remains"
	if !o.PurgeData {
		done += "\nruntime data retained at " + strings.Join(reset.DataPaths, ", ")
	}
	return runLinuxReset(env, o, "uninstall", done)
}

// retireBeforeUninstall revokes the runtime of every link in openedbot
// before the links are removed: once they are gone the host can no longer
// prove which runtime it was. A failure is reported, never blocking.
func retireBeforeUninstall(env cli.Env, plan bool) int {
	if runtime.GOOS == "darwin" {
		if code := prepareConnectorHost(env); code != 0 {
			return code
		}
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	retireLinkedInstances(ctx, env, plan)
	return cli.ExitOK
}

// askDataChoice asks whether the runtime data stays. Enter keeps it;
// purging takes the typed word, the one choice that cannot be undone.
func askDataChoice(in io.Reader, out io.Writer) (bool, error) {
	rd := bufio.NewReader(in)
	fmt.Fprintln(out, "Runtime data: bearer, provider credentials and workspaces.")
	fmt.Fprintln(out, "  1) keep it: a later `edge-setup up` finds it as it was (default)")
	fmt.Fprintln(out, "  2) purge it: irreversible")
	fmt.Fprint(out, "Choice [1/2]: ")
	choice, err := readAnswer(rd)
	if err != nil {
		return false, err
	}
	switch choice {
	case "", "1":
		return false, nil
	case "2":
	default:
		return false, fmt.Errorf("unknown choice %q", choice)
	}
	fmt.Fprintf(out, "Type %s to destroy the runtime data: ", purgeConfirmation)
	word, err := readAnswer(rd)
	if err != nil {
		return false, err
	}
	if word != purgeConfirmation {
		return false, errors.New("purge not confirmed")
	}
	return true, nil
}

// readAnswer reads one line; end of input before any answer is an error.
func readAnswer(rd *bufio.Reader) (string, error) {
	line, err := rd.ReadString('\n')
	if err != nil && line == "" {
		return "", errors.New("no answer on the terminal")
	}
	return strings.TrimSpace(line), nil
}

func init() {
	cli.Register(cli.Command{Name: "uninstall", Summary: "Remove edge-setup and its runtime; asks whether to keep the data", Run: runUninstall})
}
