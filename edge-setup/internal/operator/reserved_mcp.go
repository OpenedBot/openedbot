package operator

import (
	"net/url"
	"regexp"
	"strings"
)

// reservedMCPPrefix names the MCP servers only openedbot installs on a host
// (`openedbot_routines`, `openedbot_bot_settings`). The approval plugin lets
// some of their calls through without a gate and openedbot sends them a run
// key: a server added under such a name for anything else would receive
// both. openedbot refuses these names to its operators; here, such a name
// must at least point at openedbot's own route for it, over https. The host
// cannot check the origin: the API's (where these routes live) is not the
// link's (`link.json`), which may be another host.
const reservedMCPPrefix = "openedbot_"

var reservedMCPPaths = map[string]*regexp.Regexp{
	"openedbot_routines":     regexp.MustCompile(`^/api/mcp/routines/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`),
	"openedbot_bot_settings": regexp.MustCompile(`^/api/mcp/bot-settings/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`),
}

func reservedMCPName(name string) bool {
	return strings.HasPrefix(strings.ToLower(name), reservedMCPPrefix)
}

// platformMCPServer reports whether a reserved name points at openedbot's own
// route for that very name, over https, with nothing around it.
func platformMCPServer(name, raw string) bool {
	path, known := reservedMCPPaths[name]
	if !known {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" &&
		u.RawPath == "" && path.MatchString(u.Path)
}
