package operator

import (
	"net/http"
	"regexp"
	"strings"
)

// The operator is a fixed list of named verbs: no route takes a command, a
// path or a free argument. These two gates make that a property of the
// router instead of a habit of each handler.
//
//  1. strictPath refuses, before routing, a path with a dot segment, an
//     empty segment, or an encoded slash, backslash or NUL. ServeMux would
//     otherwise "clean" such a path and redirect the caller to a different
//     verb, or split one value into two segments.
//  2. strictMux validates every {wildcard} of a route against the grammar
//     of its name before the handler runs, so a handler that forgets a
//     check, or runs a capability probe first, never sees hostile input.
//     Handlers keep their own, stricter checks.

const maxPathBytes = 512

// wildcardGrammar is the outer grammar of each wildcard name used by
// Handler. A wildcard with no entry here makes Handler panic at start, so
// a new route cannot ship without one.
var wildcardGrammar = map[string]*regexp.Regexp{
	"provider": providerRe,
	"toolset":  toolsetRe,
	"skill":    skillRe,
	"server":   mcpNameRe,
	"name":     mcpNameRe, // MCP server names; toolset names are a subset
	"slug":     profileSlugRe,
	"session":  sessionRe,
	"job":      sessionRe,
	"uuid":     skillOperationRe,
	"peer":     a2aPolicyPeerNameRe,
	"file":     workspaceFileRe,
}

// wildcardRefusal keeps the status and code each handler already returns
// for a bad value, so the gate changes no contract.
var wildcardRefusal = map[string]struct {
	status        int
	code, message string
}{
	"provider": {http.StatusBadRequest, "PROVIDER_INVALID", "the provider name is invalid"},
	"toolset":  {http.StatusBadRequest, "TOOLSET_INVALID", "the toolset name is invalid"},
	"skill":    {http.StatusBadRequest, "SKILL_INVALID", "the skill name is invalid"},
	"server":   {http.StatusBadRequest, "NAME_INVALID", "the server name is invalid"},
	"name":     {http.StatusBadRequest, "NAME_INVALID", "the name is invalid"},
	"slug":     {http.StatusBadRequest, "PROFILE_INVALID", "the profile name is invalid"},
	"session":  {http.StatusNotFound, "SESSION_NOT_FOUND", "this session no longer exists"},
	"job":      {http.StatusNotFound, "GATEWAY_RESTART_NOT_FOUND", "this restart no longer exists"},
	"uuid":     {http.StatusNotFound, "SKILL_OPERATION_NOT_FOUND", "this skill operation no longer exists"},
	"peer":     {http.StatusBadRequest, "PEER_INVALID", "the peer name is invalid"},
	"file":     {http.StatusBadRequest, "WORKSPACE_FILE_INVALID", "the file name is invalid"},
}

func strictPath(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !cleanRequestPath(r) {
			writeError(w, http.StatusBadRequest, "PATH_INVALID", "the request path is not a plain operator route")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func cleanRequestPath(r *http.Request) bool {
	if r.URL == nil || r.URL.Opaque != "" {
		return false
	}
	escaped := r.URL.EscapedPath()
	if len(escaped) > maxPathBytes || !strings.HasPrefix(escaped, "/") {
		return false
	}
	if escaped == "/" {
		return true
	}
	lower := strings.ToLower(escaped)
	if strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") || strings.Contains(lower, "%00") {
		return false
	}
	for _, segment := range strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

type strictMux struct {
	*http.ServeMux
}

func (m strictMux) HandleFunc(pattern string, h func(http.ResponseWriter, *http.Request)) {
	names := patternWildcards(pattern)
	for _, name := range names {
		if wildcardGrammar[name] == nil {
			panic("operator: route " + pattern + " has no grammar for {" + name + "}")
		}
	}
	if len(names) == 0 {
		m.ServeMux.HandleFunc(pattern, h)
		return
	}
	m.ServeMux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		for _, name := range names {
			value := r.PathValue(name)
			if value == "." || value == ".." || !wildcardGrammar[name].MatchString(value) {
				refusal := wildcardRefusal[name]
				writeError(w, refusal.status, refusal.code, refusal.message)
				return
			}
		}
		h(w, r)
	})
}

func patternWildcards(pattern string) []string {
	var names []string
	for rest := pattern; ; {
		open := strings.IndexByte(rest, '{')
		if open < 0 {
			return names
		}
		end := strings.IndexByte(rest[open:], '}')
		if end < 0 {
			return names
		}
		name := strings.TrimSuffix(rest[open+1:open+end], "...")
		names = append(names, name)
		rest = rest[open+end+1:]
	}
}
