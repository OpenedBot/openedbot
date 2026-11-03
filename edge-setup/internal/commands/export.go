package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

// Export is the non-secret description of this runtime for openedbot.
type Export struct {
	Mode          string   `json:"mode"`
	Endpoint      string   `json:"endpoint,omitempty"`
	RuntimeID     string   `json:"runtime_id,omitempty"`
	OHB           string   `json:"ohb,omitempty"`
	HermesVersion string   `json:"hermes_version"`
	HermesCommit  string   `json:"hermes_commit"`
	Toolsets      []string `json:"toolsets"`
	Features      []string `json:"features"`
	Sandbox       bool     `json:"sandbox"`
	SSHHardening  bool     `json:"ssh_hardening"`
	ToolVersion   string   `json:"tool_version"`
	Next          string   `json:"next"`
}

func buildExport(env cli.Env) (Export, error) {
	st, err := state.Load()
	if err != nil {
		return Export{}, err
	}
	if st == nil {
		return Export{}, fmt.Errorf("nothing to export: run `edge-setup up` first")
	}
	e := Export{
		Mode: string(state.ModeConnector), HermesVersion: pins.HermesVersion, HermesCommit: pins.HermesInstallerCommit,
		Toolsets: pins.APIToolsets, Features: st.Features.EnabledNames(), Sandbox: st.DockerEnabled, SSHHardening: st.SSHHardening, ToolVersion: st.ToolVersion,
	}
	if fsx.Exists(layout.ConnectorLink) {
		var lf LinkFile
		if data, err := os.ReadFile(layout.ConnectorLink); err == nil && json.Unmarshal(data, &lf) == nil {
			e.RuntimeID, e.OHB = lf.RuntimeID, lf.OHB
		}
		e.Next = "Linked. openedbot reaches the gateway through the outbound link; nothing to configure on its side."
	} else {
		e.Next = "In openedbot: Réglages › Runtime Hermes › Appairer depuis le serveur, then run `edge-setup link --ohb <origin> --yes` here and paste the ticket at the hidden prompt."
	}
	return e, nil
}

func runExport(env cli.Env, args []string) int {
	fs := newFlagSet("export", env)
	asJSON := fs.Bool("json", false, "JSON output")
	asMD := fs.Bool("md", false, "Markdown output (the default)")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if *asJSON && *asMD {
		return fail(env, cli.ExitUsage, "--json and --md are exclusive")
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	e, err := buildExport(env)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if *asJSON {
		b, _ := json.MarshalIndent(e, "", "  ")
		printf(env.Stdout, "%s", b)
		return cli.ExitOK
	}
	printf(env.Stdout, "# Hermes runtime: coordinates for openedbot\n")
	printf(env.Stdout, "| Field | Value |\n|---|---|")
	printf(env.Stdout, "| mode | `%s` |", e.Mode)
	if e.Endpoint != "" {
		printf(env.Stdout, "| gateway | `%s` |", e.Endpoint)
	}
	if e.RuntimeID != "" {
		printf(env.Stdout, "| runtime id | `%s` |\n| openedbot | `%s` |", e.RuntimeID, e.OHB)
	}
	printf(env.Stdout, "| Hermes | `%s` @ `%s` |", e.HermesVersion, e.HermesCommit[:12])
	printf(env.Stdout, "| toolsets | `%s` |", strings.Join(e.Toolsets, ", "))
	printf(env.Stdout, "| selected features | `%s` |", strings.Join(e.Features, ", "))
	printf(env.Stdout, "| sandbox | %v |\n| ssh hardening | %v |\n| tool | `%s` |", e.Sandbox, e.SSHHardening, e.ToolVersion)
	printf(env.Stdout, "\n**Next:** %s\n\nThe gateway bearer is never part of this export.", e.Next)
	return cli.ExitOK
}

func init() {
	cli.Register(cli.Command{Name: "export", Summary: "Non-secret coordinates for openedbot (--json|--md)", ReadOnly: true, Run: runExport})
}
