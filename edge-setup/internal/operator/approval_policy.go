package operator

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

//go:embed approval_policy_plugin/* approval_policy_config.py
var approvalPolicyFiles embed.FS

const approvalPolicyPlugin = "ohb_approval_policy"
const approvalPolicyFeature = "approval_policy"

var approvalPolicyWriteTools = [...]string{"write_file", "patch", "skill_manage", "execute_code", "send_message", "cronjob"}

type approvalPolicyMode string

const (
	approvalPolicyAsk   approvalPolicyMode = "ask_writes"
	approvalPolicyBlock approvalPolicyMode = "block_writes"
	approvalPolicyOff   approvalPolicyMode = "off"
)

// approvalPolicyMaxBlockedTools bounds the per-profile list of blocked tool
// keys; a tool key is the plugin's (`write_file`, `mcp:<server>:<tool>`).
const approvalPolicyMaxBlockedTools = 64

var approvalPolicyToolKeyRe = regexp.MustCompile(`^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$`)

type approvalPolicyState struct {
	Mode          approvalPolicyMode `json:"mode"`
	PluginEnabled bool               `json:"pluginEnabled"`
	Effective     bool               `json:"effective"`
	// GateIdentity: the profile's installed plugin is byte-identical to this
	// binary's bundle, which names and describes every gate it raises
	// (PERM2-A). Proven per profile rather than announced as a host feature:
	// a profile written by an older binary keeps the older plugin until the
	// next write, and the restart marker covers the load.
	GateIdentity bool     `json:"gateIdentity"`
	BlockedTools []string `json:"blockedTools"`
}

// approvalPolicyRequest is the PUT body. A nil BlockedTools keeps the list
// already on file, so an API that only sends `mode` never clears it.
type approvalPolicyRequest struct {
	Mode         approvalPolicyMode `json:"mode"`
	BlockedTools *[]string          `json:"blockedTools,omitempty"`
}

type approvalPolicyFile struct {
	Mode         approvalPolicyMode `json:"mode"`
	BlockedTools []string           `json:"blocked_tools,omitempty"`
}

type approvalPolicyService struct {
	runtimeRoot    string
	owner          fsx.Owner
	runner         exec.Runner
	command        func(...string) exec.Cmd
	python         func(...string) exec.Cmd
	markPending    func() error
	restartPending func() bool
	now            func() time.Time
}

// approvalPolicyLoadFile records, per profile, whether the running gateway
// has the plugin loaded: "loaded" or "pending". The plugin is loaded in place
// through the gateway control socket (`reload-plugins`), so enabling it on a
// new bot never waits for a restart, and a restart pending elsewhere on the
// host (an MCP write) no longer makes every bot's policy "not effective". A
// profile without the file predates it and follows the host marker.
//
// "Not served yet" counts as loaded: edge-setup runs one gateway, the fixed
// `hermes-gateway` unit, which multiplexes every profile under the runtime
// root, so no other gateway can already serve a profile that one does not
// (Hermes' standalone per-profile gateways are not part of this layout).
const approvalPolicyLoadFile = ".load"

const (
	approvalPolicyLoaded  = "loaded"
	approvalPolicyPending = "pending"
)

func (p approvalPolicyService) state(ctx context.Context, slug string) (approvalPolicyState, error) {
	if err := p.validateProfile(slug); err != nil {
		return approvalPolicyState{}, err
	}
	policyPath := filepath.Join(p.profileHome(slug), "plugins", approvalPolicyPlugin, "policy.json")
	state, err := fsx.Lstat(policyPath)
	if err != nil || !state.Exists || state.Symlink || !state.Regular || state.Owner != p.owner {
		return approvalPolicyState{}, errors.New("approval policy file is unavailable")
	}
	if valid, err := fsx.RequireRegular(policyPath, 0o600, p.owner); err != nil || !valid {
		return approvalPolicyState{}, errors.New("approval policy file is unsafe")
	}
	policy, err := p.readPolicyFile(policyPath)
	if err != nil {
		return approvalPolicyState{}, err
	}
	enabled, err := p.pluginEnabled(ctx, slug)
	if err != nil {
		return approvalPolicyState{}, err
	}
	blocked := policy.BlockedTools
	if blocked == nil {
		blocked = []string{}
	}
	return approvalPolicyState{
		Mode: policy.Mode, PluginEnabled: enabled, Effective: enabled && p.loaded(slug),
		GateIdentity: p.bundleCurrent(slug), BlockedTools: blocked,
	}, nil
}

// loaded reports whether the gateway runs this profile's plugin. A profile
// with no load record yet is adopted as loaded once no restart is pending on
// the host; until then it stays not loaded, as before the record existed.
func (p approvalPolicyService) loaded(slug string) bool {
	state, _ := p.loadState(slug)
	switch state {
	case approvalPolicyLoaded:
		return true
	case approvalPolicyPending:
		return false
	}
	if p.pendingRestart() {
		return false
	}
	_ = p.setLoadState(slug, approvalPolicyLoaded)
	return true
}

func (p approvalPolicyService) loadPath(slug string) string {
	return filepath.Join(p.profileHome(slug), "plugins", approvalPolicyPlugin, approvalPolicyLoadFile)
}

// loadState is "" when the record is absent or cannot be trusted; a pending
// record also says since when (zero when it does not).
func (p approvalPolicyService) loadState(slug string) (string, time.Time) {
	path := p.loadPath(slug)
	state, err := fsx.Lstat(path)
	if err != nil || !state.Exists || state.Symlink || !state.Regular || state.Owner != p.owner {
		return "", time.Time{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", time.Time{}
	}
	value, since, _ := strings.Cut(strings.TrimSpace(string(data)), " ")
	switch value {
	case approvalPolicyLoaded:
		return value, time.Time{}
	case approvalPolicyPending:
		at, _ := time.Parse(time.RFC3339Nano, since)
		return value, at
	}
	return "", time.Time{}
}

func (p approvalPolicyService) setLoadState(slug, value string) error {
	if value == approvalPolicyPending {
		value += " " + p.clock().UTC().Format(time.RFC3339Nano)
	}
	return fsx.WriteAtomic(p.loadPath(slug), []byte(value+"\n"), 0o600, p.owner)
}

func (p approvalPolicyService) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// gatewayRestarted marks loaded the profiles that went pending BEFORE the
// gateway (re)started at `at`: it loaded their plugin as it was on disk. A
// profile that went pending afterwards keeps waiting (Codex review).
func (p approvalPolicyService) gatewayRestarted(at time.Time) {
	matches, err := filepath.Glob(filepath.Join(p.runtimeRoot, "profiles", "*", "plugins", approvalPolicyPlugin, approvalPolicyLoadFile))
	if err != nil {
		return
	}
	for _, path := range matches {
		slug := filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(path))))
		state, since := p.loadState(slug)
		if p.validateProfile(slug) == nil && state == approvalPolicyPending && since.Before(at) {
			_ = p.setLoadState(slug, approvalPolicyLoaded)
		}
	}
}

func (p approvalPolicyService) readPolicyFile(path string) (approvalPolicyFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return approvalPolicyFile{}, err
	}
	var policy approvalPolicyFile
	if err := json.Unmarshal(data, &policy); err != nil || !validApprovalPolicyMode(policy.Mode) || !validBlockedTools(policy.BlockedTools) {
		return approvalPolicyFile{}, errors.New("approval policy file is invalid")
	}
	return policy, nil
}

// bundleCurrent reports whether every installed plugin file equals the
// embedded bundle. Any doubt (missing, unsafe, unreadable) is false.
func (p approvalPolicyService) bundleCurrent(slug string) bool {
	entries, err := approvalPolicyFiles.ReadDir("approval_policy_plugin")
	if err != nil || len(entries) == 0 {
		return false
	}
	pluginDir := filepath.Join(p.profileHome(slug), "plugins", approvalPolicyPlugin)
	for _, entry := range entries {
		want, err := approvalPolicyFiles.ReadFile(filepath.Join("approval_policy_plugin", entry.Name()))
		if err != nil {
			return false
		}
		target := filepath.Join(pluginDir, entry.Name())
		installed, err := fsx.Lstat(target)
		if err != nil || !installed.Exists || installed.Symlink || !installed.Regular || installed.Owner != p.owner {
			return false
		}
		got, err := os.ReadFile(target)
		if err != nil || string(got) != string(want) {
			return false
		}
	}
	return true
}

func validBlockedTools(keys []string) bool {
	if len(keys) > approvalPolicyMaxBlockedTools {
		return false
	}
	seen := map[string]bool{}
	for _, key := range keys {
		if !approvalPolicyToolKeyRe.MatchString(key) || seen[key] {
			return false
		}
		seen[key] = true
	}
	return true
}

func (p approvalPolicyService) pendingRestart() bool {
	return p.restartPending != nil && p.restartPending()
}

func restartMarkerPending(path string) bool {
	_, err := os.Lstat(path)
	return err == nil || !os.IsNotExist(err)
}

func (p approvalPolicyService) set(ctx context.Context, slug string, mode approvalPolicyMode) (approvalPolicyState, error) {
	return p.write(ctx, slug, approvalPolicyRequest{Mode: mode})
}

func (p approvalPolicyService) write(ctx context.Context, slug string, request approvalPolicyRequest) (approvalPolicyState, error) {
	mode := request.Mode
	if err := p.validateProfile(slug); err != nil || !validApprovalPolicyMode(mode) || (request.BlockedTools != nil && !validBlockedTools(*request.BlockedTools)) {
		return approvalPolicyState{}, errors.New("approval policy request is invalid")
	}
	before, err := p.pluginEnabled(ctx, slug)
	if err != nil {
		return approvalPolicyState{}, err
	}
	path := filepath.Join(p.profileHome(slug), "plugins", approvalPolicyPlugin, "policy.json")
	// Keep the list on file when the request does not name one. A file that
	// cannot be read safely keeps nothing: the write starts it empty.
	var blocked []string
	if request.BlockedTools != nil {
		blocked = *request.BlockedTools
	} else if previous, statErr := fsx.Lstat(path); statErr == nil && previous.Exists && previous.Regular && !previous.Symlink && previous.Owner == p.owner {
		if current, readErr := p.readPolicyFile(path); readErr == nil {
			blocked = current.BlockedTools
		}
	}
	pluginChanged, err := p.install(slug)
	if err != nil {
		return approvalPolicyState{}, err
	}
	policy, _ := json.Marshal(approvalPolicyFile{Mode: mode, BlockedTools: blocked})
	policy = append(policy, '\n')
	if err := fsx.WriteAtomic(path, policy, 0o600, p.owner); err != nil {
		return approvalPolicyState{}, err
	}
	// A profile still pending (a restart outside openedbot, a gateway that did not
	// answer) gets another reload on any write: the reconciliation heals it.
	if state, _ := p.loadState(slug); !before || pluginChanged || state == approvalPolicyPending {
		// Never `hermes plugins enable`: its admission path initialised a
		// package-manager environment without the install's extras on the
		// lab, and the gateway lost its API server (2026-10-22). The config
		// program enables the plugin, then asks the gateway to load it.
		if err := p.setLoadState(slug, approvalPolicyPending); err != nil {
			return approvalPolicyState{}, err
		}
		load, err := p.enablePlugin(ctx, slug)
		if err != nil {
			return approvalPolicyState{}, err
		}
		if load == "loaded" || load == "lazy" {
			if err := p.setLoadState(slug, approvalPolicyLoaded); err != nil {
				return approvalPolicyState{}, err
			}
		} else if err := p.ensureRestartPending(); err != nil {
			// No gateway answered the reload: only a restart loads the plugin.
			return approvalPolicyState{}, err
		}
	}
	readback, err := p.state(ctx, slug)
	if err != nil || readback.Mode != mode || !readback.PluginEnabled || !readback.GateIdentity || !sameBlockedTools(readback.BlockedTools, blocked) {
		return approvalPolicyState{}, errors.New("approval policy write could not be verified")
	}
	return readback, nil
}

func sameBlockedTools(got, want []string) bool {
	return len(got) == len(want) && slices.Equal(got, want)
}

// enablePlugin enables the plugin in the profile configuration and asks the
// gateway to load it; it returns how the load went: "loaded" (proven by the
// gateway's answer), "lazy" (the profile is not served yet, its first use
// loads it) or "pending" (no answer: only a restart loads it).
func (p approvalPolicyService) enablePlugin(ctx context.Context, slug string) (string, error) {
	program, err := approvalPolicyFiles.ReadFile("approval_policy_config.py")
	if err != nil || p.python == nil || p.runner == nil {
		return "", errors.New("approval policy profile configuration is unavailable")
	}
	cmd := p.python("-")
	cmd.Stdin = append(program, '\n')
	cmd.Env = append(cmd.Env, "OHB_APPROVAL_PROFILE="+slug, "OHB_APPROVAL_ROOT="+p.runtimeRoot, "OHB_APPROVAL_ENABLE=1", "OHB_APPROVAL_RELOAD=1")
	result, err := exec.Must(ctx, p.runner, cmd)
	if err != nil {
		return "", errors.New("approval policy profile configuration could not be updated")
	}
	var answer struct {
		Load *string `json:"load"`
	}
	if json.Unmarshal([]byte(result.Stdout), &answer) != nil || answer.Load == nil {
		return approvalPolicyPending, nil
	}
	return *answer.Load, nil
}

func (p approvalPolicyService) ensureRestartPending() error {
	if p.markPending == nil {
		return errors.New("approval policy restart marker is unavailable")
	}
	if err := p.markPending(); err != nil {
		return errors.New("approval policy restart marker could not be written")
	}
	return nil
}

func (p approvalPolicyService) install(slug string) (bool, error) {
	if err := p.validateProfile(slug); err != nil {
		return false, err
	}
	home := p.profileHome(slug)
	for _, dir := range []string{p.runtimeRoot, filepath.Join(p.runtimeRoot, "profiles"), home} {
		state, err := fsx.Lstat(dir)
		if err != nil || !state.Exists || !state.Dir || state.Symlink || state.Owner != p.owner {
			return false, errors.New("approval policy profile directory is unsafe")
		}
	}
	pluginDir := filepath.Join(home, "plugins", approvalPolicyPlugin)
	if err := fsx.EnsureDirUnder(home, pluginDir, 0o700, p.owner); err != nil {
		return false, err
	}
	entries, err := approvalPolicyFiles.ReadDir("approval_policy_plugin")
	if err != nil || len(entries) != 2 {
		return false, errors.New("approval policy plugin bundle is invalid")
	}
	changed := false
	for _, entry := range entries {
		data, err := approvalPolicyFiles.ReadFile(filepath.Join("approval_policy_plugin", entry.Name()))
		if err != nil || strings.Contains(entry.Name(), string(filepath.Separator)) {
			return false, errors.New("approval policy plugin bundle is invalid")
		}
		target := filepath.Join(pluginDir, entry.Name())
		installed, statErr := fsx.Lstat(target)
		if statErr != nil || (installed.Exists && (installed.Symlink || !installed.Regular || installed.Owner != p.owner)) {
			return false, errors.New("approval policy plugin file is unsafe")
		}
		old, readErr := os.ReadFile(target)
		if !installed.Exists || readErr != nil || string(old) != string(data) {
			// Recorded before the gateway-loaded files change: a crash leaves
			// the profile pending, never "loaded" on stale code.
			if err := p.setLoadState(slug, approvalPolicyPending); err != nil {
				return false, err
			}
			changed = true
			if err := fsx.WriteAtomic(target, data, 0o600, p.owner); err != nil {
				return false, err
			}
		}
	}
	return changed, nil
}

func (p approvalPolicyService) pluginEnabled(ctx context.Context, slug string) (bool, error) {
	if err := p.validateProfile(slug); err != nil || p.runner == nil || p.command == nil {
		return false, errors.New("approval policy profile configuration is unavailable")
	}
	if p.python == nil {
		return false, errors.New("approval policy interpreter is unavailable")
	}
	program, err := approvalPolicyFiles.ReadFile("approval_policy_config.py")
	if err != nil {
		return false, err
	}
	cmd := p.python("-")
	configPath := filepath.Join(p.profileHome(slug), "config.yaml")
	configState, err := fsx.Lstat(configPath)
	if err != nil || !configState.Exists || configState.Symlink || !configState.Regular || configState.Owner != p.owner {
		return false, errors.New("approval policy profile configuration is unsafe")
	}
	if valid, err := fsx.RequireRegular(configPath, 0, p.owner); err != nil || !valid {
		return false, errors.New("approval policy profile configuration is unsafe")
	}
	cmd.Stdin = append(program, '\n')
	cmd.Env = append(cmd.Env, "OHB_APPROVAL_PROFILE="+slug, "OHB_APPROVAL_ROOT="+p.runtimeRoot)
	result, err := exec.Must(ctx, p.runner, cmd)
	if err != nil {
		return false, err
	}
	var enabled struct {
		Enabled  bool `json:"enabled"`
		Disabled bool `json:"disabled"`
	}
	if json.Unmarshal([]byte(result.Stdout), &enabled) != nil {
		return false, errors.New("approval policy profile configuration is unreadable")
	}
	return enabled.Enabled && !enabled.Disabled, nil
}

func (p approvalPolicyService) profileHome(slug string) string {
	return filepath.Join(p.runtimeRoot, "profiles", slug)
}

func (p approvalPolicyService) validateProfile(slug string) error {
	if !profileSlugRe.MatchString(slug) || slug == "default" || p.runtimeRoot == "" || !filepath.IsAbs(p.runtimeRoot) || filepath.Clean(p.runtimeRoot) != p.runtimeRoot {
		return errors.New("approval policy profile is invalid")
	}
	return nil
}

func validApprovalPolicyMode(mode approvalPolicyMode) bool {
	return mode == approvalPolicyAsk || mode == approvalPolicyBlock || mode == approvalPolicyOff
}

func approvalPolicyHandler(read func(context.Context, string) (approvalPolicyState, error), write func(context.Context, string, approvalPolicyRequest) (approvalPolicyState, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		slug := r.PathValue("slug")
		if !profileSlugRe.MatchString(slug) || slug == "default" || r.URL.RawQuery != "" || r.URL.ForceQuery {
			writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the named profile request is invalid")
			return
		}
		if r.Method == http.MethodGet {
			if read == nil {
				writeError(w, http.StatusServiceUnavailable, "APPROVAL_POLICY_UNAVAILABLE", "the profile approval policy is unavailable on this host")
				return
			}
			state, err := read(r.Context(), slug)
			if err != nil {
				writeError(w, http.StatusBadGateway, "APPROVAL_POLICY_UNAVAILABLE", "the profile approval policy could not be read safely")
				return
			}
			writeJSON(w, http.StatusOK, state)
			return
		}
		if write == nil {
			writeError(w, http.StatusServiceUnavailable, "APPROVAL_POLICY_UNAVAILABLE", "the profile approval policy is unavailable on this host")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
		var request approvalPolicyRequest
		decoder := json.NewDecoder(strings.NewReader(string(body)))
		decoder.DisallowUnknownFields()
		decodeErr := decoder.Decode(&request)
		trailingErr := decoder.Decode(new(any))
		if err != nil || len(body) > MaxBody || decodeErr != nil || trailingErr != io.EOF || !validApprovalPolicyMode(request.Mode) ||
			(request.BlockedTools != nil && !validBlockedTools(*request.BlockedTools)) {
			writeError(w, http.StatusBadRequest, "BODY_INVALID", "the approval policy mode is invalid")
			return
		}
		state, err := write(r.Context(), slug, request)
		if err != nil || state.Mode != request.Mode || !state.PluginEnabled || (request.BlockedTools != nil && !sameBlockedTools(state.BlockedTools, *request.BlockedTools)) {
			writeError(w, http.StatusBadGateway, "APPROVAL_POLICY_UNVERIFIED", "the profile approval policy write could not be verified")
			return
		}
		writeJSON(w, http.StatusOK, state)
	}
}
