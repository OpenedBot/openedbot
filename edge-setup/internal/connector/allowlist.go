package connector

import (
	"regexp"
	"strings"
)

// Route is one allowed gateway route.
type Route struct {
	Method string
	Path   *regexp.Regexp
	// Events marks the SSE route, exempt from the first-response limit.
	Events bool
	// Host marks a route served by the connector itself (through the
	// operator socket); it never reaches the loopback gateway.
	Host bool
}

const idSeg = `[A-Za-z0-9._~-]{1,128}`

// sessionSeg is a Hermes session id: a run id's grammar PLUS the colon.
//
// Every session openedbot opens is named `openedbot:<org>:<...>`, and
// encodeURIComponent writes that colon as `%3A` in the path. idSeg knows
// neither form, so an allowlist built on it refuses all three session routes
// for the only name openedbot can produce.
//
// `%3A` is the ONLY escape admitted: neither `%2F`, nor `%2E`, nor a bare `%`
// gets through, and the length bound stays. A `/` or a `..` smuggled in
// percent form, which the gateway would decode back into a path, stays
// impossible.
//
// 256: the longest key, `openedbot:<uuid>:workflow:<uuid>:bot:<uuid>`, is 127
// characters, 137 once its five colons are escaped.
const sessionSeg = `(?:[A-Za-z0-9._~-]|%3[Aa]){1,256}`

const providerSeg = `[a-z0-9][a-z0-9_-]{0,63}`

// toolsetSeg is a Hermes toolset key; mcpSeg is an MCP server or catalogue
// entry name, which upstream allows to carry uppercase and dashes.
const toolsetSeg = `[a-z0-9][a-z0-9_]{0,63}`
const mcpSeg = `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`
const profileSeg = `[a-z0-9][a-z0-9_-]{0,62}`
const a2aPeerSeg = `[a-z0-9][a-z0-9._-]{0,63}`

// skillSeg is a Hermes skill folder name. Same bound as toolsetSeg, plus
// the hyphen: bundled skills include `hermes-agent` and hub entries with
// dashes. Uppercase is refused because names are lowercased on disk.
const skillSeg = `[a-z0-9][a-z0-9_-]{0,63}`

// workspaceFileSeg is one file name at the root of the bots' `/workspace`:
// no slash, no leading dot, a fixed list of viewable extensions.
const workspaceFileSeg = `(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(?:png|jpg|jpeg|webp|pdf))`
const uuidSeg = `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`

// HostPrefix is the path prefix of the routes served on the host.
const HostPrefix = "/hermes-setup/"

// Allowlist is the exact set of routes openedbot consumes.
// Anything else is refused before touching the loopback. It must stay
// identical to contracts/connector/src/relay-allowlist.ts in OpenedBot/openedbot.
var Allowlist = []Route{
	{Method: "GET", Path: regexp.MustCompile(`^/health$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/v1/capabilities$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/v1/models$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/v1/toolsets$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/v1/skills$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/api/model/options$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/api/mcp/servers$`)},
	{Method: "POST", Path: regexp.MustCompile(`^/api/sessions$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/api/sessions/` + sessionSeg + `$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/api/sessions/` + sessionSeg + `/messages$`)},
	// The link's only destructive gateway write: erasing a session openedbot
	// created here, when the operator purges the bot that owned it. It can only
	// name an `openedbot:<org>:<thread>` id, the only identifier openedbot knows,
	// touches neither the profile nor the host.
	{Method: "DELETE", Path: regexp.MustCompile(`^/api/sessions/` + sessionSeg + `$`)},
	{Method: "POST", Path: regexp.MustCompile(`^/v1/runs$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/v1/runs/` + idSeg + `$`)},
	{Method: "GET", Path: regexp.MustCompile(`^/v1/runs/` + idSeg + `/events$`), Events: true},
	{Method: "POST", Path: regexp.MustCompile(`^/v1/runs/` + idSeg + `/(stop|steer|approval|resolve-unknown)$`)},
	// Host routes: provider credentials and device-code OAuth through
	// hermes-operator, plus its bounded read-only capabilities, usage and
	// model-context reads (docs/CONNECTOR.md). The groups below add further
	// named writes; none of them is a shell, a path or a command.
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/capabilities$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/usage$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/model-context$`), Host: true},
	// Read-only report of SDK import availability in the gateway Python.
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/provider-sdks$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/providers/` + providerSeg + `/credentials$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/providers/` + providerSeg + `/oauth$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/providers/` + providerSeg + `/oauth/` + idSeg + `$`), Host: true},
	{Method: "DELETE", Path: regexp.MustCompile(`^/hermes-setup/providers/` + providerSeg + `/oauth/` + idSeg + `$`), Host: true},
	// Host routes: the toolset and MCP verbs, the writes that let the owner
	// administer this runtime's capability surface from openedbot instead
	// of from a console on the host. Each one names a toolset key, an MCP
	// server, or a catalogue entry, never a command, a path, or a shell.
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/toolsets$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/toolsets/` + toolsetSeg + `$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/mcp/servers$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/mcp/servers$`), Host: true},
	{Method: "DELETE", Path: regexp.MustCompile(`^/hermes-setup/mcp/servers/` + mcpSeg + `$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/mcp/catalog/` + mcpSeg + `$`), Host: true},
	// Host routes: MCP OAuth. An `auth: oauth` server is inert until a
	// browser has authorized it, and a headless host has no browser: the
	// authorization URL goes out to openedbot, the provider's callback
	// (`code` + `state`) comes back through it. Each route names a server and
	// at most a session id; `state` is validated on the host.
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/mcp/servers/` + mcpSeg + `/oauth$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/mcp/servers/` + mcpSeg + `/oauth/` + idSeg + `$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/mcp/servers/` + mcpSeg + `/oauth/callback$`), Host: true},
	{Method: "DELETE", Path: regexp.MustCompile(`^/hermes-setup/mcp/servers/` + mcpSeg + `/oauth/` + idSeg + `$`), Host: true},
	// Host routes: the gateway restart. The gateway loads its MCP servers at
	// boot only, so every MCP write above is invisible to runs until it
	// restarts. This is the ONE restart the link carries: a fixed route, a
	// fixed unit (hermes-gateway), no argument, proven on /health, and a
	// read that says whether it is even needed.
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/gateway$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/gateway/restart$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/gateway/restart/` + idSeg + `$`), Host: true},
	// Host routes: named profile lifecycle and capability writes, plus the
	// inventory/avatar reads. Every variable is still a bounded name; the
	// operator turns the writes into fixed probe verbs and never receives a
	// path, command or shell.
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/profiles$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/avatar$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles$`), Host: true},
	{Method: "DELETE", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/toolsets/` + toolsetSeg + `$`), Host: true},
	// Several toolsets of one profile in one write (feature
	// profile_toolsets_batch); the names travel in the body, each checked
	// against the toolset class by the operator.
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/toolsets$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/memory$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/memory$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/model$`), Host: true},
	// One model written into many profiles (feature profile_model_batch); the
	// profile names travel in the body, each checked against the slug class.
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/models$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/approval-policy$`), Host: true},
	{Method: "PUT", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/approval-policy$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/mcp/servers/` + mcpSeg + `$`), Host: true},
	{Method: "DELETE", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/mcp/servers/` + mcpSeg + `$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/skills/` + skillSeg + `$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/bundled-skills$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/providers/` + providerSeg + `/credentials$`), Host: true},
	{Method: "DELETE", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/providers/` + providerSeg + `/credentials$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/skills/hub/search$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/skills/hub/inspect$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/skills/hub/scan$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/skills/hub/install$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/skills/hub/operations/` + uuidSeg + `$`), Host: true},
	{Method: "DELETE", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/skills/` + skillSeg + `$`), Host: true},
	// Host route: the bounded session inventory (identifiers, owning profile,
	// start time), the read openedbot reconciles with its own dispatches
	// to detect a run created outside the link. Never a message, never a path.
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/sessions-inventory$`), Host: true},
	// Host route: one file a bot made, read from the root of the terminal
	// sandbox's `/workspace`, so the worker can attach what the bot named in
	// a `MEDIA:` line. A bounded file name, never a path or a directory; the
	// operator also proves the bytes are an image or a PDF. Root only, no query.
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/workspace/files/` + workspaceFileSeg + `$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/profiles/` + profileSeg + `/workspace/files/` + workspaceFileSeg + `$`), Host: true},
	// Host route: the root's installed skills, read by the operator; the
	// fallback for a gateway whose /v1/skills fails (upstream #142575).
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/skills$`), Host: true},
	// The host operator reads only the fixed A2A Agent Card path on loopback.
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/a2a/agent-card$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/a2a/audit$`), Host: true},
	{Method: "GET", Path: regexp.MustCompile(`^/hermes-setup/a2a/peers$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/a2a/peers/` + a2aPeerSeg + `/trust$`), Host: true},
	{Method: "POST", Path: regexp.MustCompile(`^/hermes-setup/a2a/peers/` + a2aPeerSeg + `/token$`), Host: true},
	{Method: "DELETE", Path: regexp.MustCompile(`^/hermes-setup/a2a/peers/` + a2aPeerSeg + `/token$`), Host: true},
}

var profilePrefix = regexp.MustCompile(`^/p/[a-z0-9][a-z0-9_-]{0,62}`)

// Match returns the route for method+path (query stripped, optional
// /p/<slug> prefix), or nil.
func Match(method, path string) *Route {
	p := path
	query := ""
	hasQuery := false
	if i := strings.IndexByte(p, '?'); i >= 0 {
		query, hasQuery = p[i+1:], true
		p = p[:i]
	}
	if strings.Contains(p, "..") || strings.Contains(p, "//") || !strings.HasPrefix(p, "/") {
		return nil
	}
	profiled := false
	if m := profilePrefix.FindString(p); m != "" {
		profiled = true
		p = p[len(m):]
		if p == "" {
			return nil
		}
	}
	if p == "/hermes-setup/a2a/audit" && (profiled || (hasQuery && !a2aAuditQuery.MatchString(query))) {
		return nil
	}
	if (p == "/hermes-setup/a2a/peers" || strings.HasPrefix(p, "/hermes-setup/a2a/peers/")) && (profiled || hasQuery) {
		return nil
	}
	if (strings.HasPrefix(p, "/hermes-setup/workspace/") || (strings.HasPrefix(p, "/hermes-setup/profiles/") && strings.Contains(p, "/workspace/"))) && (profiled || hasQuery) {
		return nil
	}
	method = strings.ToUpper(method)
	for i := range Allowlist {
		r := &Allowlist[i]
		if r.Method == method && r.Path.MatchString(p) {
			return r
		}
	}
	return nil
}

var a2aAuditQuery = regexp.MustCompile(`^limit=([1-9]|[1-9][0-9]|100)$`)

// ForwardedRequestHeaders are the only request headers relayed to the
// gateway; the bearer is added locally.
// `cache-control` lets openedbot's « Actualiser » ask the operator for a fresh
// account-usage probe instead of its one-minute cache. `traceparent` is
// relayed only when it is well formed (trace.go), and journaled.
var ForwardedRequestHeaders = map[string]bool{"accept": true, "cache-control": true, "content-type": true, "idempotency-key": true, "last-event-id": true, TraceparentHeader: true}

// ForwardedResponseHeaders are the only response headers relayed back.
var ForwardedResponseHeaders = map[string]bool{"content-type": true, "retry-after": true}
