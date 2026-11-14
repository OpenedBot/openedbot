package commands

import (
	"flag"
	"runtime"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/reset"
)

// resetFlags declares the options reset and uninstall share.
func resetFlags(fs *flag.FlagSet, o *reset.Options) {
	fs.BoolVar(&o.Plan, "plan", false, "list what would be removed and exit")
	fs.BoolVar(&o.Plan, "dry-run", false, "same as --plan")
	fs.BoolVar(&o.PurgeData, "purge-data", false, "also remove runtime data (bearer, credentials, workspaces; Linux service home)")
	fs.BoolVar(&o.DataLossAccepted, "i-understand-data-loss", false, "required with --purge-data")
	fs.BoolVar(&o.PurgePackages, "purge-packages", false, "also purge docker-ce and containerd.io")
	fs.BoolVar(&o.Legacy, "legacy", false, "Linux: also purge the legacy openhermesbot-* namespace of the previous tool (macOS reset always removes its legacy installation)")
	fs.BoolVar(&o.PurgeTailscale, "purge-tailscale", false, "with --legacy: also purge tailscale and its firewall rules (it may be your way in)")
	fs.BoolVar(&o.RemoveAdmin, "remove-admin", false, "also remove the hermes-admin account and its sudoers file (refused from its own session)")
	fs.BoolVar(&o.RestoreCloudUser, "restore-cloud-user", false, "restore the quarantined cloud-init account from backups")
}

func runReset(env cli.Env, args []string) int {
	fs := newFlagSet("reset", env)
	var o reset.Options
	yes := fs.Bool("yes", false, "confirm the mutation")
	resetFlags(fs, &o)
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "reset takes no positional argument")
	}
	if runtime.GOOS == "darwin" {
		return runMacReset(env, o, *yes, "reset")
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	if !*yes && !o.Plan {
		return fail(env, cli.ExitRefused, "reset mutates the host; add --yes (or --plan to preview)")
	}
	return runLinuxReset(env, o, "reset", "reset complete: no hermes-* unit or path remains")
}

// runLinuxReset runs a confirmed reset as root, then fails on any residue.
func runLinuxReset(env cli.Env, o reset.Options, verb, done string) int {
	ctx, cancel := ctxWithSignals()
	defer cancel()
	r := reset.New(runner, func(f string, a ...any) { printf(env.Stdout, f, a...) })
	if err := r.Run(ctx, o); err != nil {
		return fail(env, cli.ExitFailure, "%s: %v", verb, err)
	}
	if o.Plan {
		return cli.ExitOK
	}
	residue, err := r.Residue(ctx, o.Legacy)
	if err != nil {
		return fail(env, cli.ExitFailure, "residue check: %v", err)
	}
	if len(residue) > 0 {
		for _, x := range residue {
			printf(env.Stdout, "residue: %s", x)
		}
		return cli.ExitFailure
	}
	printf(env.Stdout, "%s", done)
	return cli.ExitOK
}

func init() {
	cli.Register(cli.Command{Name: "reset", Summary: "Remove everything this tool installed", Run: runReset})
}
