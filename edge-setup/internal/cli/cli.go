// Package cli parses the edge-setup command line and dispatches to the
// command implementations. The one gate shared by every command lives here:
// an argv that would carry a secret is refused before the process elevates
// itself, so the secret never reaches sudo's journal. Each command declares
// its own mutation gates (--yes, --console-confirmed, …).
package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/journal"
	"github.com/OpenedBot/openedbot/edge-setup/internal/term"
)

// Exit codes. They are part of the operator contract.
const (
	ExitOK        = 0
	ExitFailure   = 1
	ExitRefused   = 2  // a gate refused the action; nothing was mutated
	ExitUsage     = 64 // EX_USAGE
	ExitNotImpl   = 69 // EX_UNAVAILABLE: command not implemented yet
	ExitPrivilege = 77 // EX_NOPERM
	// ExitLinkRefused is EX_CONFIG: openedbot revoked the link. The connector unit lists it in RestartPreventExitStatus.
	ExitLinkRefused = 78
	// ExitOriginDown is EX_TEMPFAIL: a loopback openedbot origin (a dev
	// tunnel) stayed unreachable for LoopbackDownLimit. The connector unit lists
	// it in RestartPreventExitStatus; `make link-dev-up` restarts the unit.
	ExitOriginDown = 75
)

// Env is what a command gets from the process.
type Env struct {
	Version string
	Stdout  io.Writer
	Stderr  io.Writer
	// Elevate re-executes the same command line as root when the process is
	// not root. It returns the child's exit code and true when it ran; nil
	// (tests) or (0, false) leaves the command to fail with ExitPrivilege.
	Elevate func(args []string) (int, bool)
	// Color decides whether a command may write ANSI escapes to Stdout. Run
	// resolves it from Stdout, --no-color, NO_COLOR, TERM and
	// EDGE_SETUP_COLOR before a command's Run is called; the zero value
	// (no escapes) is safe when a command's Run is invoked directly in a
	// test.
	Color term.Color
	// Journal is the install journal (root-only JSON lines, secrets masked)
	// that every command changing the host appends its output to. Empty
	// (tests, macOS) journals nothing.
	Journal string
}

// Command is one subcommand.
type Command struct {
	Name     string
	Summary  string
	ReadOnly bool
	Run      func(env Env, args []string) int
	// Placeholder marks a command scheduled for a later milestone; a real
	// registration replaces it.
	Placeholder bool
}

var commands = map[string]Command{}

// Register adds a command; called from init() of each command file.
func Register(c Command) {
	if existing, dup := commands[c.Name]; dup && !existing.Placeholder {
		panic("duplicate command " + c.Name)
	}
	commands[c.Name] = c
}

// VersionName is the name `version` prints for the executable invoked as
// arg0: hermes-setup when its file name carries the pre-rename name,
// edge-setup otherwise. A v0.4.0 binary checking a candidate runs it as
// `.hermes-setup.candidate version` and accepts only "hermes-setup <version>",
// so this keeps existing hosts able to upgrade to this release (OHB-87).
func VersionName(arg0 string) string {
	if strings.Contains(filepath.Base(arg0), "hermes-setup") {
		return "hermes-setup"
	}
	return "edge-setup"
}

// Run dispatches argv and returns the exit code.
func Run(args []string, env Env) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		_, noColor := stripNoColor(args)
		usage(env.Stdout, term.Detect(env.Stdout, noColor))
		return ExitOK
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Fprintf(env.Stdout, "%s %s\n", VersionName(os.Args[0]), env.Version)
		return ExitOK
	}
	c, ok := commands[args[0]]
	if !ok {
		fmt.Fprintf(env.Stderr, "edge-setup: unknown command %q\n\n", args[0])
		usage(env.Stderr, term.Detect(env.Stderr, false))
		return ExitUsage
	}
	// Refuse a secret in argv before elevation: sudo logs the full command
	// line, and the process table shows it to every local user.
	if msg := RefuseSecretFlags(args[1:]); msg != "" {
		fmt.Fprintf(env.Stderr, "edge-setup %s: %s\n", args[0], msg)
		return ExitRefused
	}
	if env.Elevate != nil && NeedsRoot(args[0]) {
		if code, ran := env.Elevate(args); ran {
			return code
		}
	}
	// --no-color is a global flag: strip it here so a command's own flag.FlagSet
	// (which knows nothing about it) does not reject it, and resolve the
	// colour decision once for the whole command.
	rest, noColor := stripNoColor(args[1:])
	env.Color = term.Detect(env.Stdout, noColor)
	if env.Journal == "" || c.ReadOnly || c.Name == "internal" || os.Geteuid() != 0 {
		return c.Run(env, rest)
	}
	j, err := openJournal(env.Journal, c.Name, env.Version, rest)
	if err != nil {
		fmt.Fprintf(env.Stderr, "edge-setup %s: install journal unavailable (%v); going on without it\n", c.Name, err)
		return c.Run(env, rest)
	}
	env.Stdout, env.Stderr = j.Tee(env.Stdout, "out"), j.Tee(env.Stderr, "err")
	code := c.Run(env, rest)
	j.Close(code)
	return code
}

// openJournal creates the journal's directory root-only when it is missing
// (a first `up`); an existing directory keeps its mode.
func openJournal(path, command, version string, args []string) (*journal.Journal, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return journal.Open(path, command, version, args)
}

// stripNoColor removes every "--no-color" entry from args, returning the
// filtered slice and whether the flag was present.
func stripNoColor(args []string) ([]string, bool) {
	found := false
	out := make([]string, 0, len(args))
	for _, a := range args {
		if a == "--no-color" {
			found = true
			continue
		}
		out = append(out, a)
	}
	return out, found
}

// rootFree lists the commands that never touch root-only state: they run
// as the invoking user. Every other command reads /etc/hermes or mutates
// the host, so `edge-setup status` typed by the admin is re-executed with
// sudo instead of failing on a permission denied.
// `internal` decides privileges after parsing its private entry point:
// connector deliberately runs as the locked-down hermes account,
// while rollback-access, proxy-rollback and operator still call requireRoot.
// Elevating `internal` here would make the connector unit invoke sudo under
// NoNewPrivileges=true and enter a permanent restart loop.
var rootFree = map[string]bool{"help": true, "version": true, "self-verify": true, "internal": true}

// NeedsRoot reports whether a command must run as root.
func NeedsRoot(name string) bool { return !rootFree[name] }

func usage(w io.Writer, color term.Color) {
	names := make([]string, 0, len(commands))
	for n := range commands {
		names = append(names, n)
	}
	sort.Strings(names)
	fmt.Fprintln(w, "usage: edge-setup <command> [flags]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Installs and links a Hermes runtime; host hardening is opt-in.")
	fmt.Fprintln(w, "Every mutation requires --yes; nothing is printed that is secret.")
	fmt.Fprintln(w)
	for _, n := range names {
		c := commands[n]
		tag := ""
		if c.ReadOnly {
			tag = color.Dim("  (read-only)")
		}
		fmt.Fprintf(w, "  %s %s%s\n", color.Bold(fmt.Sprintf("%-16s", n)), c.Summary, tag)
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "  %s Print the version\n", color.Bold(fmt.Sprintf("%-16s", "version")))
}

// notImplemented is the placeholder Run for commands scheduled in later
// milestones. It exits 69 and mutates nothing.
func notImplemented(name string) func(Env, []string) int {
	return func(env Env, _ []string) int {
		fmt.Fprintf(env.Stderr, "edge-setup %s: not implemented in this build\n", name)
		return ExitNotImpl
	}
}

// forbiddenFlags never exist: a secret must arrive on stdin or in a 0600 file.
var forbiddenFlags = []string{"--token", "--api-key", "--bearer", "--secret", "--password", "--authkey", "--ticket", "--link-token"}

// RefuseSecretFlags returns a non-empty message when argv carries a flag
// that would place a secret in the process table. Run applies it to every
// command before elevation; it is exported for tests and for callers that
// pre-validate an argv they are about to build.
func RefuseSecretFlags(args []string) string {
	for _, a := range args {
		for _, f := range forbiddenFlags {
			if a == f || strings.HasPrefix(a, f+"=") {
				return fmt.Sprintf("refusing %s: secrets are read from stdin or a 0600 file, never from the command line", f)
			}
		}
	}
	return ""
}

func init() {
	for _, c := range []struct {
		name, summary string
		readOnly      bool
	}{
		{"detect", "Report host facts and connector-only readiness", true},
		{"plan", "Print exactly what `up` would do; writes nothing", true},
		{"up", "Install and connect the runtime; host policies are opt-in", false},
		{"verify-access", "Prove fresh SSH access and commit a guarded policy", false},
		{"link", "Pair this runtime with openedbot over its outbound connector", false},
		{"credentials", "List, add, login (OAuth) or remove a model-provider credential", false},
		{"toolsets", "List, enable or disable a toolset on the api_server platform", false},
		{"mcp", "List, add or remove an MCP server on this host", false},
		{"doctor", "Check the running runtime end to end", true},
		{"audit", "Security inventory of the host (report is root-only)", true},
		{"status", "Phases, hardening, connector state and installed versions", true},
		{"export", "Non-secret coordinates for openedbot (--json|--md)", true},
		{"update", "Re-apply pins, or --self to upgrade this binary (alias of upgrade)", false},
		{"upgrade", "Replace the installed binary (verified release or --from file) and restart its units", false},
		{"reset", "Remove everything this tool installed", false},
		{"uninstall", "Remove edge-setup and its runtime; asks whether to keep the data", false},
		{"self-verify", "Verify the binary against the signed release SHA256SUMS", true},
	} {
		Register(Command{Name: c.name, Summary: c.summary, ReadOnly: c.readOnly, Run: notImplemented(c.name), Placeholder: true})
	}
}
