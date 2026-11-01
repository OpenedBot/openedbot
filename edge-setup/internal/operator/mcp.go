package operator

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// MCPServer is the public view of one configured MCP server.
//
// No field carries a secret. `Endpoint` is a location; a stdio server is named
// by its command with neither argv nor environment values; the environment is
// reported by KEY only, because an MCP entry's env value is routinely a token.
type MCPServer struct {
	Name            string   `json:"name"`
	Transport       string   `json:"transport"`
	Endpoint        *string  `json:"endpoint"`
	Command         *string  `json:"command"`
	Auth            string   `json:"auth"`
	ConfigEnabled   bool     `json:"configEnabled"`
	PlatformEnabled bool     `json:"platformEnabled"`
	ToolsIncluded   []string `json:"toolsIncluded"`
	ToolsExcluded   []string `json:"toolsExcluded"`
	EnvKeys         []string `json:"envKeys"`
	DiscoveredTools []string `json:"discoveredTools,omitempty"`
	Unreachable     bool     `json:"unreachable,omitempty"`
	// OAuthTokenPresent says whether upstream holds a token file for an
	// `auth: oauth` server, never its content. nil for the other auth modes.
	// A registered server without one is not usable: the client refuses to
	// open a session and the gateway never lists its tools.
	OAuthTokenPresent *bool `json:"oauthTokenPresent"`
}

// MCPCatalogEnvSpec is one variable a catalogue entry declares. Only the
// declaration crosses; a value never travels in this direction.
type MCPCatalogEnvSpec struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Required    bool    `json:"required"`
	Secret      bool    `json:"secret"`
}

// MCPCatalogEntry is one Nous-approved entry present on this host.
type MCPCatalogEntry struct {
	Name            string              `json:"name"`
	Description     *string             `json:"description"`
	Source          *string             `json:"source"`
	AuthType        string              `json:"authType"`
	AuthProvider    *string             `json:"authProvider"`
	Transport       string              `json:"transport"`
	RequiresInstall bool                `json:"requiresInstall"`
	EnvSpecs        []MCPCatalogEnvSpec `json:"envSpecs"`
}

// MCPInventory is the wire shape of GET /hermes-setup/mcp/servers.
type MCPInventory struct {
	Platform string            `json:"platform"`
	Servers  []MCPServer       `json:"servers"`
	Catalog  []MCPCatalogEntry `json:"catalog"`
}

type mcpAddBody struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Auth    string `json:"auth"`
	Token   string `json:"token"`
	Replace bool   `json:"replace"`
	// Command is refused rather than ignored: a caller that asked for a stdio
	// server must be told the link carries no executable toward the host, not
	// left with a server it did not describe.
	Command *string `json:"command"`
}

type mcpInstallBody struct {
	Name string            `json:"name"`
	Env  map[string]string `json:"env"`
}

func (s *Server) mcpInventory(w http.ResponseWriter, r *http.Request) {
	var doc MCPInventory
	if err := s.runProbe(r.Context(), "mcp-inventory", nil, &doc); err != nil {
		s.writeProbeFailure(w, "mcp-inventory", err)
		return
	}
	normalizeInventory(&doc)
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) mcpAdd(w http.ResponseWriter, r *http.Request) {
	var body mcpAddBody
	if !readBody(w, r, &body) {
		return
	}
	if body.Command != nil {
		writeError(w, http.StatusBadRequest, "STDIO_REFUSED",
			"the link carries no executable toward the host; add an https endpoint, or install a catalogue entry")
		return
	}
	if body.Auth == "" {
		body.Auth = "none"
	}
	// The probe checks all of this again; refusing here keeps hostile input
	// from ever reaching a process running as the service user.
	if !mcpNameRe.MatchString(body.Name) {
		writeError(w, http.StatusBadRequest, "NAME_INVALID", "the server name must be 1-64 characters of [A-Za-z0-9_-]")
		return
	}
	if !validHTTPSURL(body.URL) {
		writeError(w, http.StatusBadRequest, "URL_INVALID", "the endpoint URL must be an https:// URL of at most 2048 characters")
		return
	}
	switch body.Auth {
	case "none", "oauth":
		// Only auth header uses a token; any other is never forwarded.
		body.Token = ""
	case "header":
		if !validSecretValue(body.Token) {
			writeError(w, http.StatusBadRequest, "SECRET_INVALID", "the bearer token is missing, too long or contains control characters")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "AUTH_INVALID", "auth must be none, header or oauth")
		return
	}
	// The token travels in the JSON body to the probe's stdin, never in argv,
	// never in a log line, and never back out in any response.
	if !s.mcpBusy.TryLock() {
		writeError(w, http.StatusConflict, "MCP_IN_PROGRESS", "an MCP change is already running; retry once it completes")
		return
	}
	defer s.mcpBusy.Unlock()

	var result struct {
		Server MCPServer `json:"server"`
	}
	request := map[string]any{"name": body.Name, "url": body.URL, "auth": body.Auth, "replace": body.Replace}
	if body.Token != "" {
		request["token"] = body.Token
	}
	if err := s.runProbe(r.Context(), "mcp-add", request, &result); err != nil {
		s.writeProbeFailure(w, "mcp-add", err)
		return
	}
	normalizeServer(&result.Server)
	s.markMCPRestartPending()
	writeJSON(w, http.StatusOK, result.Server)
}

func (s *Server) mcpInstall(w http.ResponseWriter, r *http.Request) {
	var body mcpInstallBody
	if !readBody(w, r, &body) {
		return
	}
	// The entry is the one the route names. A body that names another one
	// is refused, never silently preferred.
	name := r.PathValue("name")
	if !mcpNameRe.MatchString(name) || (body.Name != "" && body.Name != name) {
		writeError(w, http.StatusBadRequest, "NAME_INVALID", "the catalogue entry name is invalid")
		return
	}
	body.Name = name
	if len(body.Env) > maxCatalogEnv {
		writeError(w, http.StatusBadRequest, "ENV_INVALID", "too many environment values")
		return
	}
	for key, value := range body.Env {
		if !envKeyRe.MatchString(key) || !validSecretValue(value) {
			writeError(w, http.StatusBadRequest, "ENV_INVALID", "environment names are [A-Z0-9_] and values 1-4096 printable characters")
			return
		}
	}
	if !s.mcpBusy.TryLock() {
		writeError(w, http.StatusConflict, "MCP_IN_PROGRESS", "an MCP change is already running; retry once it completes")
		return
	}
	defer s.mcpBusy.Unlock()

	var result struct {
		Server MCPServer `json:"server"`
	}
	request := map[string]any{"name": body.Name}
	if len(body.Env) > 0 {
		request["env"] = body.Env
	}
	if err := s.runProbe(r.Context(), "mcp-install", request, &result); err != nil {
		s.writeProbeFailure(w, "mcp-install", err)
		return
	}
	normalizeServer(&result.Server)
	s.markMCPRestartPending()
	writeJSON(w, http.StatusOK, result.Server)
}

func (s *Server) mcpRemove(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !mcpNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, "NAME_INVALID", "the server name is invalid")
		return
	}
	if !s.mcpBusy.TryLock() {
		writeError(w, http.StatusConflict, "MCP_IN_PROGRESS", "an MCP change is already running; retry once it completes")
		return
	}
	defer s.mcpBusy.Unlock()

	var result struct {
		TokensRemoved bool `json:"tokensRemoved"`
	}
	if err := s.runProbe(r.Context(), "mcp-remove", map[string]any{"name": name}, &result); err != nil {
		s.writeProbeFailure(w, "mcp-remove", err)
		return
	}
	s.markMCPRestartPending()
	// 200, not 204: the root's OAuth state goes with the entry, and a token
	// file that survived must be said, never left for nobody to revoke.
	writeJSON(w, http.StatusOK, MCPServerRemoval{Name: name, TokensRemoved: result.TokensRemoved})
}

// MCPServerRemoval is the wire shape of DELETE /mcp/servers/{name}.
type MCPServerRemoval struct {
	Name string `json:"name"`
	// TokensRemoved is false when an OAuth token file of the root survived.
	TokensRemoved bool `json:"tokensRemoved"`
}

const (
	maxMCPURL     = 2048
	maxSecret     = 4096
	maxCatalogEnv = 16
)

var envKeyRe = regexp.MustCompile(`^[A-Z0-9_]{1,64}$`)

func validHTTPSURL(raw string) bool {
	if len(raw) > maxMCPURL || !strings.HasPrefix(raw, "https://") || hasControl(raw) {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil
}

func validSecretValue(raw string) bool {
	return raw != "" && len(raw) <= maxSecret && !hasControl(raw)
}

func readBody(w http.ResponseWriter, r *http.Request, into any) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(raw) > MaxBody {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is missing or too large")
		return false
	}
	if err := json.Unmarshal(raw, into); err != nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is not JSON")
		return false
	}
	return true
}

// normalizeInventory replaces every nil slice with an empty one: a page that
// reads `servers: null` as "unknown" and `[]` as "none" must never have to
// guess which one the host meant.
func normalizeInventory(doc *MCPInventory) {
	if doc.Platform == "" {
		doc.Platform = toolsetPlatform
	}
	if doc.Servers == nil {
		doc.Servers = []MCPServer{}
	}
	if doc.Catalog == nil {
		doc.Catalog = []MCPCatalogEntry{}
	}
	for i := range doc.Servers {
		normalizeServer(&doc.Servers[i])
	}
	for i := range doc.Catalog {
		if doc.Catalog[i].EnvSpecs == nil {
			doc.Catalog[i].EnvSpecs = []MCPCatalogEnvSpec{}
		}
	}
}

func normalizeServer(server *MCPServer) {
	if server.EnvKeys == nil {
		server.EnvKeys = []string{}
	}
	if server.Transport == "" {
		server.Transport = "unknown"
	}
	if server.Auth == "" {
		server.Auth = "none"
	}
}
