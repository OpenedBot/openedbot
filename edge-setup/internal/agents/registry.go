// Package agents lists the agent CLIs a user can connect to openedbot from
// their own machine, and finds them under the current account.
package agents

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Agent is one CLI that `edge-setup connect` knows how to drive.
type Agent struct {
	// Engine is the `hello.engine` of its link; every local engine starts with `local:`.
	Engine string
	Name   string
	// Provider is the slug of its model catalogue.
	Provider string
	// Binary is the executable started by the bridge, with Args.
	Binary string
	Args   []string
	// Codex: the Codex App Server dialect; otherwise ACP.
	Codex bool
	// Login is the command that logs the CLI in.
	Login string
	// Requires is the CLI that must be present for an adapter Binary to be
	// worth installing, and Install the command that installs it.
	Requires string
	Install  []string
	// Env lists the variables passed to the agent besides PATH and HOME.
	Env []string
}

// Known is every agent `edge-setup connect` looks for, in display order.
var Known = []Agent{
	{Engine: "local:codex", Name: "Codex", Provider: "openai-codex", Binary: "codex", Args: []string{"app-server"}, Codex: true, Login: "codex login", Env: []string{"CODEX_HOME"}},
	{Engine: "local:claude", Name: "Claude Code", Provider: "claude-code", Binary: "claude-agent-acp", Login: "claude /login",
		Requires: "claude", Install: []string{"bun", "add", "-g", "@agentclientprotocol/claude-agent-acp"}, Env: []string{"CLAUDE_CONFIG_DIR"}},
	{Engine: "local:grok", Name: "Grok", Provider: "grok-cli", Binary: "grok", Args: []string{"agent", "stdio"}, Login: "grok login"},
	{Engine: "local:gemini", Name: "Gemini CLI", Provider: "gemini-cli", Binary: "gemini", Args: []string{"--acp"}, Login: "gemini", Env: []string{"GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT"}},
	{Engine: "local:opencode", Name: "OpenCode", Provider: "opencode-cli", Binary: "opencode", Args: []string{"acp"}, Login: "opencode auth login"},
}

// Dirs are searched after PATH: a service starts with a short PATH, and the
// usual per-user install locations of these CLIs are not always in it.
func Dirs(home string) []string {
	return []string{
		filepath.Join(home, ".local/bin"), filepath.Join(home, ".bun/bin"), filepath.Join(home, ".opencode/bin"),
		filepath.Join(home, ".grok/bin"), filepath.Join(home, ".npm-global/bin"),
		"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
	}
}

// SearchPath is the PATH every agent runs with: the caller's, then Dirs.
func SearchPath(home string) string {
	parts := []string{}
	if current := os.Getenv("PATH"); current != "" {
		parts = append(parts, current)
	}
	return strings.Join(append(parts, Dirs(home)...), string(os.PathListSeparator))
}

// ErrNotFound means the executable is not installed under this account.
var ErrNotFound = errors.New("not installed")

// Find returns the absolute path of an executable in path.
func Find(name, path string) (string, error) {
	for _, dir := range filepath.SplitList(path) {
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return candidate, nil
		}
	}
	return "", ErrNotFound
}

// Environment is the agent's whole environment: never the caller's secrets,
// only the paths it needs and the variables the agent names.
func (a Agent) Environment(home, path string) []string {
	env := []string{"PATH=" + path, "HOME=" + home}
	for _, name := range append([]string{"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "LANG"}, a.Env...) {
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	return env
}

// Slug is the engine name without its `local:` prefix, for directory names.
func (a Agent) Slug() string { return strings.TrimPrefix(a.Engine, "local:") }
