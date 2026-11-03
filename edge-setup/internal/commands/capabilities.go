package commands

import (
	"encoding/json"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

var toolsetKeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_]{0,63}$`)
var mcpNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// runToolsets is the console twin of the toolset verb openedbot drives
// through the link: the same `hermes tools … --platform api_server`, the same
// refusal list, and the same proof: the new state is READ BACK from
// /v1/toolsets rather than taken from the CLI's exit code, which stays 0 even
// when the CLI printed a refusal.
func runToolsets(env cli.Env, args []string) int {
	if len(args) == 0 {
		args = []string{"list"}
	}
	verb, rest := args[0], args[1:]
	fs := newFlagSet("toolsets "+verb, env)
	yes := fs.Bool("yes", false, "confirm the mutation")
	if err := fs.Parse(rest); err != nil {
		return cli.ExitUsage
	}
	if code := prepareRuntimeCLI(env); code != 0 {
		return code
	}
	h, err := currentRuntimeCLI()
	if err != nil {
		return fail(env, cli.ExitFailure, "runtime context could not be prepared: %v", err)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()

	token, err := h.Token()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	client := gateway.Loopback(token)

	if verb == "list" {
		body, err := client.ToolsetInventory(ctx)
		if err != nil {
			return fail(env, cli.ExitFailure, "the runtime inventory could not be read: %v", err)
		}
		return printToolsets(env, body)
	}
	if verb != "enable" && verb != "disable" {
		return fail(env, cli.ExitUsage, "usage: edge-setup toolsets list | enable <name> --yes | disable <name> --yes")
	}
	if fs.NArg() != 1 || !toolsetKeyRe.MatchString(fs.Arg(0)) {
		return fail(env, cli.ExitUsage, "toolsets %s requires exactly one toolset key (e.g. browser)", verb)
	}
	name := fs.Arg(0)
	if !*yes {
		return fail(env, cli.ExitRefused, "toolsets %s changes what every run may call; add --yes (nothing was changed)", verb)
	}
	if verb == "enable" && slices.Contains(pins.ForbiddenToolsets, name) {
		return fail(env, cli.ExitRefused,
			"%s runs work outside the run openedbot leases, budgets and journals; it stays off on this host", name)
	}

	cmd := h.Command("tools", verb, name, "--platform", "api_server")
	cmd.Timeout = operator.ToolsetTimeout
	if _, err := exec.Must(ctx, runner, cmd); err != nil {
		return fail(env, cli.ExitFailure, "the runtime refused the toolset change: %v", err)
	}
	body, err := client.ToolsetInventory(ctx)
	if err != nil {
		return fail(env, cli.ExitFailure, "the change was written but the inventory could not be read back: %v", err)
	}
	enabled, err := gateway.ToolsetEnabled(body, name)
	if err != nil {
		return fail(env, cli.ExitFailure, "the change was written but the inventory could not be read back: %v", err)
	}
	if enabled != (verb == "enable") {
		return fail(env, cli.ExitFailure,
			"the CLI accepted the change and the inventory still reports %s as enabled=%v; check agent.disabled_toolsets", name, enabled)
	}
	printf(env.Stdout, "%s is now enabled=%v on the api_server platform", name, enabled)
	return cli.ExitOK
}

func printToolsets(env cli.Env, body []byte) int {
	var payload struct {
		Data []struct {
			Name       string `json:"name"`
			Enabled    bool   `json:"enabled"`
			Configured bool   `json:"configured"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Data == nil {
		return fail(env, cli.ExitFailure, "the runtime inventory is not a toolset list")
	}
	rows := payload.Data
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	forbidden := map[string]bool{}
	for _, name := range pins.ForbiddenToolsets {
		forbidden[name] = true
	}
	for _, row := range rows {
		state := "off"
		switch {
		case row.Enabled && row.Configured:
			state = "ready"
		case row.Enabled:
			state = "needs configuration"
		}
		note := ""
		if forbidden[row.Name] {
			note = "  (refused by the openedbot contract)"
		}
		printf(env.Stdout, "%-24s %s%s", row.Name, state, note)
	}
	return cli.ExitOK
}

// runMCP is the console twin of the MCP verbs the link carries. `list` reads
// the host's own configuration through the operator's interpreter program, so
// the console and the link report from exactly one source.
func runMCP(env cli.Env, args []string) int {
	if len(args) == 0 {
		args = []string{"list"}
	}
	verb, rest := args[0], args[1:]
	fs := newFlagSet("mcp "+verb, env)
	url := fs.String("url", "", "https endpoint of the server (add)")
	auth := fs.String("auth", "none", "none | header | oauth (add)")
	tokenFile := fs.String("token-file", "", "0600 file holding the bearer token (add --auth header)")
	yes := fs.Bool("yes", false, "confirm the mutation")
	if err := fs.Parse(rest); err != nil {
		return cli.ExitUsage
	}
	if code := prepareRuntimeCLI(env); code != 0 {
		return code
	}
	h, err := currentRuntimeCLI()
	if err != nil {
		return fail(env, cli.ExitFailure, "runtime context could not be prepared: %v", err)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()

	probe, err := h.Probe()
	if err != nil {
		return fail(env, cli.ExitFailure, "the inventory program could not be installed: %v", err)
	}
	run := func(verb string, request any) (map[string]any, int) {
		body := []byte("{}")
		if request != nil {
			encoded, err := json.Marshal(request)
			if err != nil {
				return nil, fail(env, cli.ExitFailure, "%v", err)
			}
			body = encoded
		}
		raw, err := probe(ctx, verb, body)
		if err != nil {
			return nil, fail(env, cli.ExitFailure, "the host could not complete %s: %v", verb, err)
		}
		var doc map[string]any
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fail(env, cli.ExitFailure, "the host returned invalid JSON for %s", verb)
		}
		if detail, ok := doc["error"].(map[string]any); ok {
			return nil, fail(env, cli.ExitFailure, "%v: %v", detail["code"], detail["message"])
		}
		return doc, cli.ExitOK
	}

	switch verb {
	case "list":
		doc, code := run("mcp-inventory", nil)
		if doc == nil {
			return code
		}
		return printMCP(env, doc)
	case "add", "remove":
	default:
		return fail(env, cli.ExitUsage,
			"usage: edge-setup mcp list | add <name> --url https://… [--auth header --token-file F] --yes | remove <name> --yes")
	}
	if fs.NArg() != 1 || !mcpNameRe.MatchString(fs.Arg(0)) {
		return fail(env, cli.ExitUsage, "mcp %s requires exactly one server name", verb)
	}
	name := fs.Arg(0)
	if !*yes {
		return fail(env, cli.ExitRefused, "mcp %s changes what every run may call; add --yes (nothing was changed)", verb)
	}
	if verb == "remove" {
		doc, code := run("mcp-remove", map[string]any{"name": name})
		if code != cli.ExitOK {
			return code
		}
		if doc["removed"] != name {
			return fail(env, cli.ExitFailure, "MCP removal did not prove the requested server; the write is unverified")
		}
		if err := markCLIGatewayRestart(h.RestartMarker); err != nil {
			return fail(env, cli.ExitFailure, "MCP write completed but activation status is unverified: %v", err)
		}
		printf(env.Stdout, "removed the MCP server %q", name)
		return cli.ExitOK
	}
	if !strings.HasPrefix(*url, "https://") {
		return fail(env, cli.ExitUsage, "mcp add requires --url with an https endpoint")
	}
	request := map[string]any{"name": name, "url": *url, "auth": *auth, "replace": true}
	if *auth == "header" {
		// Same rule as an API key: the secret arrives by file or by prompt and
		// travels on stdin, never in argv where /proc would expose it.
		secret, err := readSecret(*tokenFile, "bearer token", "--token-file", "bearer token for "+name+" (not echoed): ")
		if err != nil {
			return fail(env, cli.ExitRefused, "%v", err)
		}
		request["token"] = secret
	}
	doc, code := run("mcp-add", request)
	if doc == nil {
		return code
	}
	server, ok := doc["server"].(map[string]any)
	if !ok || server["name"] != name {
		return fail(env, cli.ExitFailure, "MCP inventory did not prove the requested server; the write is unverified")
	}
	if err := markCLIGatewayRestart(h.RestartMarker); err != nil {
		return fail(env, cli.ExitFailure, "MCP write completed but activation status is unverified: %v", err)
	}
	if server["unreachable"] == true {
		return fail(env, cli.ExitFailure,
			"%s was saved but could not be reached; fix the endpoint then run `hermes mcp test %s`", name, name)
	}
	tools, _ := server["discoveredTools"].([]any)
	printf(env.Stdout, "added the MCP server %q (%d tool(s) discovered)", name, len(tools))
	return cli.ExitOK
}

func printMCP(env cli.Env, doc map[string]any) int {
	servers, _ := doc["servers"].([]any)
	if len(servers) == 0 {
		printf(env.Stdout, "no MCP server is configured on this host")
	}
	for _, raw := range servers {
		server, _ := raw.(map[string]any)
		if server == nil {
			continue
		}
		where, _ := server["endpoint"].(string)
		if where == "" {
			where, _ = server["command"].(string)
		}
		printf(env.Stdout, "%-24s %-8s %-8s %s",
			server["name"], server["transport"], server["auth"], where)
	}
	catalog, _ := doc["catalog"].([]any)
	if len(catalog) > 0 {
		printf(env.Stdout, "")
		printf(env.Stdout, "catalogue (%d entr(y|ies)): install one with `hermes mcp install <name>`", len(catalog))
	}
	return cli.ExitOK
}

func init() {
	cli.Register(cli.Command{
		Name:    "toolsets",
		Summary: "List, enable or disable a toolset on the api_server platform",
		Run:     runToolsets,
	})
	cli.Register(cli.Command{
		Name:    "mcp",
		Summary: "List, add or remove an MCP server on this host",
		Run:     runMCP,
	})
}
