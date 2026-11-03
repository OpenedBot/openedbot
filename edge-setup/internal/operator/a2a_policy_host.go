package operator

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const (
	a2aPolicyPythonTimeout = 20 * time.Second
	maxA2APolicyOutput     = 16 << 10
)

// a2aPolicyHostPython is embedded in edge-setup and invokes only Hermes'
// pinned config/env APIs. It has no caller-provided path, URL, method, or key.
//
//go:embed a2a_policy_host.py
var a2aPolicyHostPython string

type a2aPolicyProcessState struct {
	Known                bool
	Running              bool
	Generation           string
	PeerNames            []string
	TrustedPeers         []string
	PeerTokensOverride   bool // A mismatch with the managed .env was observed at gateway startup.
	TrustedPeersOverride bool
	AllowAllUsers        bool
	LocalhostOnly        bool // Upstream tokenless mode, independent of the bind address.
}

type a2aPolicyProcessObserver func(context.Context) (a2aPolicyProcessState, error)
type a2aPolicyPeerProver func(context.Context, string, string, A2APeerAccess) (a2aPolicyProbeResult, error)
type a2aPolicyCommand func(action string) exec.Cmd

// a2aPolicyHostConfig is built only by the Linux/macOS host factories. The
// command callback names a fixed local Python interpreter and fixed script;
// relay fields never contribute command arguments or file paths.
type a2aPolicyHostConfig struct {
	RuntimeRoot    string
	Owner          fsx.Owner
	Runner         exec.Runner
	Command        a2aPolicyCommand
	ObserveProcess a2aPolicyProcessObserver
	ProbePeer      a2aPolicyPeerProver
}

type a2aPolicyFileState struct {
	PeerTokens             string            `json:"peerTokens"`
	PeerTokensPresent      bool              `json:"peerTokensPresent"`
	TrustedPeersEnv        string            `json:"trustedPeersEnv"`
	TrustedPeersEnvPresent bool              `json:"trustedPeersEnvPresent"`
	AllowAllEnv            string            `json:"allowAllEnv"`
	AllowAllEnvPresent     bool              `json:"allowAllEnvPresent"`
	ConfigTrusted          []string          `json:"configTrusted"`
	OutgoingPeers          []a2aOutgoingPeer `json:"outgoingPeers"`
}

type a2aPolicyHost struct {
	cfg a2aPolicyHostConfig
	mu  sync.Mutex
}

func newA2APolicyHost(cfg a2aPolicyHostConfig) (*a2aPolicyHost, error) {
	if cfg.Runner == nil || cfg.Command == nil || cfg.Owner.UID < 0 || cfg.Owner.GID < 0 ||
		cfg.RuntimeRoot == "" || !filepath.IsAbs(cfg.RuntimeRoot) || filepath.Clean(cfg.RuntimeRoot) != cfg.RuntimeRoot || cfg.RuntimeRoot == string(filepath.Separator) {
		return nil, errors.New("A2A peer policy host dependencies are invalid")
	}
	return &a2aPolicyHost{cfg: cfg}, nil
}

func (h *a2aPolicyHost) Read(ctx context.Context) (A2APolicyView, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	file, process, err := h.snapshot(ctx)
	if err != nil {
		return A2APolicyView{}, err
	}
	peerTokens := file.PeerTokens
	if !file.PeerTokensPresent {
		peerTokens = ""
	}
	trustedEnv := ""
	allowAll := parseA2ABool(file.AllowAllEnv)
	if file.TrustedPeersEnvPresent {
		trustedEnv = file.TrustedPeersEnv
	}
	view, err := projectA2APolicy(peerTokens, trustedEnv, file.ConfigTrusted, allowAll)
	if err != nil {
		return A2APolicyView{}, err
	}
	if process.Known && process.Running {
		view.ProcessObserved = true
		view.AccessMode = "default_allow"
		view.TrustedPeersSource = "none"
		if process.AllowAllUsers {
			view.AccessMode = "allow_all_override"
		} else if process.LocalhostOnly {
			view.AccessMode = "localhost_only"
		} else if len(process.TrustedPeers) > 0 {
			view.AccessMode = "trusted_peers"
		}
		if process.TrustedPeersOverride {
			view.TrustedPeersSource = "environment"
		} else if len(process.TrustedPeers) > 0 {
			view.TrustedPeersSource = "config"
		}
		seen := make(map[string]struct{}, len(view.Peers))
		for i, peer := range view.Peers {
			seen[peer.Identity] = struct{}{}
			view.Peers[i].TokenConfigured = a2aContainsString(process.PeerNames, peer.Identity)
			view.Peers[i].Access = observedA2APeerAccess(process, peer.Identity)
		}
		for _, name := range append(append([]string(nil), process.PeerNames...), process.TrustedPeers...) {
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			peer := A2APeerPolicy{Identity: name, TokenConfigured: a2aContainsString(process.PeerNames, name), Access: observedA2APeerAccess(process, name), OutgoingAccess: A2APeerDeny}
			if !strings.HasPrefix(name, "ip:") {
				peer.Name = name
			}
			view.Peers = append(view.Peers, peer)
		}
		sort.Slice(view.Peers, func(i, j int) bool { return view.Peers[i].Identity < view.Peers[j].Identity })
	}
	for _, outgoing := range file.OutgoingPeers {
		index := -1
		for i := range view.Peers {
			if view.Peers[i].Identity == outgoing.Name {
				index = i
				break
			}
		}
		if index < 0 {
			view.Peers = append(view.Peers, A2APeerPolicy{Name: outgoing.Name, Identity: outgoing.Name, Access: A2APeerDeny, OutgoingAccess: A2APeerDeny})
			index = len(view.Peers) - 1
		}
		view.Peers[index].OutgoingConfigured = true
		view.Peers[index].OutgoingTokenPresent = outgoing.TokenPresent
		if view.ProcessObserved && a2aContainsString(process.TrustedPeers, outgoing.Name) {
			view.Peers[index].OutgoingAccess = A2APeerAllow
		}
	}
	sort.Slice(view.Peers, func(i, j int) bool { return view.Peers[i].Identity < view.Peers[j].Identity })
	return view, nil
}

// Observed identities and trust come from the running gateway. Pending file
// writes must not be presented as live authentication or access decisions.
func observedA2APeerAccess(process a2aPolicyProcessState, name string) A2APeerAccess {
	if !strings.HasPrefix(name, "ip:") && !a2aContainsString(process.PeerNames, name) {
		return A2APeerDeny
	}
	if process.AllowAllUsers || process.LocalhostOnly || len(process.TrustedPeers) == 0 || a2aContainsString(process.TrustedPeers, name) {
		return A2APeerAllow
	}
	return A2APeerDeny
}

func (h *a2aPolicyHost) Write(ctx context.Context, mutation a2aPeerMutation) (a2aPolicyWriteStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !validA2APeerName(mutation.name) {
		return a2aPolicyWriteStatus{}, errors.New("A2A peer request is invalid")
	}
	file, process, err := h.snapshot(ctx)
	if err != nil {
		return a2aPolicyWriteStatus{}, err
	}
	switch mutation.kind {
	case a2aPeerTrustMutation:
		if mutation.trusted == nil || !process.Known || !process.Running {
			return a2aPolicyWriteStatus{Persisted: false}, errors.New("A2A process policy state is unavailable")
		}
		trustedEnv := ""
		if process.TrustedPeersOverride {
			trustedEnv = strings.Join(process.TrustedPeers, ",")
		}
		if file.TrustedPeersEnvPresent && strings.TrimSpace(file.TrustedPeersEnv) != "" {
			trustedEnv = file.TrustedPeersEnv
		}
		delta, err := applyA2APeerTrustWithRegistration(file.PeerTokens, trustedEnv, file.ConfigTrusted, process.AllowAllUsers || parseA2ABool(file.AllowAllEnv), mutation.name, *mutation.trusted, a2aOutgoingRegistered(file.OutgoingPeers, mutation.name))
		if err != nil {
			return a2aPolicyWriteStatus{}, err
		}
		if delta.trustedPeersChanged {
			if err := h.writeTrustedPeers(ctx, delta.trustedPeers); err != nil {
				return a2aPolicyWriteStatus{Persisted: false}, err
			}
		}
		after, currentProcess, err := h.snapshot(ctx)
		if err != nil || !equalStrings(normalizedOrNil(after.ConfigTrusted), delta.trustedPeers) {
			return a2aPolicyWriteStatus{Persisted: false}, errors.New("A2A trusted-peer readback failed")
		}
		if !currentProcess.Known || !currentProcess.Running || currentProcess.TrustedPeersOverride || currentProcess.AllowAllUsers {
			return a2aPolicyWriteStatus{Persisted: true}, nil
		}
		if !equalStrings(currentProcess.TrustedPeers, delta.trustedPeers) {
			return a2aPolicyWriteStatus{Persisted: true}, nil
		}
		if a2aOutgoingRegistered(after.OutgoingPeers, mutation.name) && !a2aContainsString(currentProcess.PeerNames, mutation.name) {
			return a2aPolicyWriteStatus{Persisted: true, Effective: true}, nil
		}
		token, ok := a2aPeerToken(after.PeerTokens, mutation.name)
		if !ok || h.cfg.ProbePeer == nil || !a2aContainsString(currentProcess.PeerNames, mutation.name) {
			return a2aPolicyWriteStatus{Persisted: true}, nil
		}
		expected := A2APeerDeny
		if *mutation.trusted {
			expected = A2APeerAllow
		}
		proof, proofErr := h.cfg.ProbePeer(ctx, mutation.name, token, expected)
		return a2aPolicyWriteStatus{Persisted: true, Effective: proofErr == nil && probeMatches(proof, expected)}, nil
	case a2aPeerTokenMutation:
		if mutation.token == nil {
			return a2aPolicyWriteStatus{}, errors.New("A2A peer token request is invalid")
		}
		if process.PeerTokensOverride {
			return a2aPolicyWriteStatus{}, errors.New("the A2A token source is outside the managed private environment")
		}
		delta, err := applyA2APeerToken(file.PeerTokens, mutation.name, mutation.token)
		if err != nil {
			return a2aPolicyWriteStatus{}, err
		}
		if delta.peerTokensChanged || !file.PeerTokensPresent {
			if err := h.writePeerTokens(ctx, delta.peerTokens); err != nil {
				return a2aPolicyWriteStatus{Persisted: false}, err
			}
		}
		after, currentProcess, err := h.snapshot(ctx)
		if err != nil || !after.PeerTokensPresent || after.PeerTokens != delta.peerTokens {
			return a2aPolicyWriteStatus{Persisted: false}, errors.New("A2A peer-token readback failed")
		}
		if !currentProcess.Known || !currentProcess.Running || currentProcess.PeerTokensOverride {
			return a2aPolicyWriteStatus{Persisted: true, NeedsGatewayRestart: true}, nil
		}
		expected := h.expectedAccess(after, currentProcess, mutation.name)
		if h.verifyPeer(ctx, after, currentProcess, mutation.name, *mutation.token, expected) {
			return a2aPolicyWriteStatus{Persisted: true, Effective: true}, nil
		}
		return a2aPolicyWriteStatus{Persisted: true, NeedsGatewayRestart: true}, nil
	case a2aPeerDeleteTokenMutation:
		if !process.Known || !process.Running {
			return a2aPolicyWriteStatus{Persisted: false}, errors.New("A2A process policy state is unavailable")
		}
		if process.PeerTokensOverride {
			return a2aPolicyWriteStatus{}, errors.New("the A2A token source is outside the managed private environment")
		}
		delta, err := applyA2APeerToken(file.PeerTokens, mutation.name, nil)
		if err != nil {
			return a2aPolicyWriteStatus{}, err
		}
		if delta.peerTokensChanged || !file.PeerTokensPresent {
			if err := h.writePeerTokens(ctx, delta.peerTokens); err != nil {
				return a2aPolicyWriteStatus{Persisted: false}, err
			}
		}
		after, currentProcess, err := h.snapshot(ctx)
		if err != nil || !after.PeerTokensPresent || after.PeerTokens != delta.peerTokens {
			return a2aPolicyWriteStatus{Persisted: false}, errors.New("A2A peer-token deletion readback failed")
		}
		if !currentProcess.Known || !currentProcess.Running || currentProcess.Generation == "" || currentProcess.PeerTokensOverride {
			return a2aPolicyWriteStatus{Persisted: true, NeedsGatewayRestart: true}, nil
		}
		for _, name := range currentProcess.PeerNames {
			if name == mutation.name {
				return a2aPolicyWriteStatus{Persisted: true, NeedsGatewayRestart: true}, nil
			}
		}
		return a2aPolicyWriteStatus{Persisted: true, Effective: true}, nil
	default:
		return a2aPolicyWriteStatus{}, errors.New("A2A peer mutation kind is invalid")
	}
}

func (h *a2aPolicyHost) snapshot(ctx context.Context) (a2aPolicyFileState, a2aPolicyProcessState, error) {
	if err := h.checkFiles(); err != nil {
		return a2aPolicyFileState{}, a2aPolicyProcessState{}, errors.New("A2A policy files are missing or unsafe")
	}
	file, err := h.runPython(ctx, "read", map[string]any{})
	if err != nil {
		return a2aPolicyFileState{}, a2aPolicyProcessState{}, err
	}
	if _, err := parseA2APeerTokens(file.PeerTokens); err != nil {
		return a2aPolicyFileState{}, a2aPolicyProcessState{}, errors.New("the A2A peer token configuration is invalid")
	}
	trusted, err := normalizeA2ATrustedPeers(file.ConfigTrusted)
	if err != nil {
		return a2aPolicyFileState{}, a2aPolicyProcessState{}, errors.New("the A2A trusted-peer configuration is invalid")
	}
	file.ConfigTrusted = trusted
	if len(file.OutgoingPeers) > maxA2APolicyPeers {
		return a2aPolicyFileState{}, a2aPolicyProcessState{}, errors.New("the A2A outgoing peer configuration is invalid")
	}
	seenOutgoing := make(map[string]bool, len(file.OutgoingPeers))
	for _, peer := range file.OutgoingPeers {
		if !validA2APeerName(peer.Name) || seenOutgoing[peer.Name] {
			return a2aPolicyFileState{}, a2aPolicyProcessState{}, errors.New("the A2A outgoing peer configuration is invalid")
		}
		seenOutgoing[peer.Name] = true
	}
	process := a2aPolicyProcessState{}
	if h.cfg.ObserveProcess != nil {
		process, err = h.cfg.ObserveProcess(ctx)
		if err != nil {
			return a2aPolicyFileState{}, a2aPolicyProcessState{}, errors.New("the A2A process environment could not be inspected")
		}
		if err := validateA2APolicyProcessState(process); err != nil {
			return a2aPolicyFileState{}, a2aPolicyProcessState{}, errors.New("the A2A process environment is invalid")
		}
	}
	return file, process, nil
}

func a2aOutgoingRegistered(peers []a2aOutgoingPeer, name string) bool {
	for _, peer := range peers {
		if peer.Name == name {
			return true
		}
	}
	return false
}

func (h *a2aPolicyHost) runPython(ctx context.Context, action string, request any) (a2aPolicyFileState, error) {
	if action != "read" && action != "token-set" && action != "trust-set" {
		return a2aPolicyFileState{}, errors.New("A2A policy operation is invalid")
	}
	body, err := json.Marshal(request)
	if err != nil || len(body) > MaxBody {
		return a2aPolicyFileState{}, errors.New("A2A policy request is invalid")
	}
	command := h.cfg.Command(action)
	if command.Path == "" {
		return a2aPolicyFileState{}, errors.New("A2A policy interpreter is unavailable")
	}
	command.Args = append(command.Args, "-c", a2aPolicyHostPython, action)
	command.Stdin = body
	command.Timeout = a2aPolicyPythonTimeout
	result, err := h.cfg.Runner.Run(ctx, command)
	if err != nil || result.ExitCode != 0 || len(result.Stdout) == 0 || len(result.Stdout) > maxA2APolicyOutput {
		return a2aPolicyFileState{}, errors.New("the local A2A policy helper failed")
	}
	if err := rejectDuplicateJSONKeys([]byte(result.Stdout)); err != nil {
		return a2aPolicyFileState{}, errors.New("the local A2A policy helper returned ambiguous data")
	}
	var state a2aPolicyFileState
	decoder := json.NewDecoder(bytes.NewReader([]byte(result.Stdout)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return a2aPolicyFileState{}, errors.New("the local A2A policy helper returned invalid data")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return a2aPolicyFileState{}, errors.New("the local A2A policy helper returned trailing data")
	}
	return state, nil
}

func (h *a2aPolicyHost) writePeerTokens(ctx context.Context, value string) error {
	if len(value) > maxA2APeerTokens {
		return errors.New("the A2A peer token configuration is too large")
	}
	_, err := h.runPython(ctx, "token-set", map[string]string{"value": value})
	return err
}

func (h *a2aPolicyHost) writeTrustedPeers(ctx context.Context, peers []string) error {
	trusted, err := normalizeA2ATrustedPeers(peers)
	if err != nil {
		return errors.New("the A2A trusted-peer configuration is invalid")
	}
	_, err = h.runPython(ctx, "trust-set", map[string][]string{"trustedPeers": trusted})
	return err
}

func (h *a2aPolicyHost) checkFiles() error {
	root, err := fsx.Lstat(h.cfg.RuntimeRoot)
	if err != nil || !root.Exists || !root.Dir || root.Symlink || root.Owner != h.cfg.Owner {
		return errors.New("A2A runtime home is unsafe")
	}
	for _, path := range []string{filepath.Join(h.cfg.RuntimeRoot, ".env"), filepath.Join(h.cfg.RuntimeRoot, "config.yaml")} {
		if _, err := fsx.RequireRegular(path, 0o600, h.cfg.Owner); err != nil {
			return errors.New("A2A policy file is unsafe")
		}
	}
	return nil
}

func (h *a2aPolicyHost) expectedAccess(file a2aPolicyFileState, process a2aPolicyProcessState, name string) A2APeerAccess {
	if process.Known && process.Running {
		if process.AllowAllUsers || process.LocalhostOnly {
			return A2APeerAllow
		}
		if len(process.TrustedPeers) == 0 {
			return A2APeerAllow
		}
		if a2aContainsString(process.TrustedPeers, name) {
			return A2APeerAllow
		}
		return A2APeerDeny
	}
	if parseA2ABool(file.AllowAllEnv) || len(file.TrustedPeersEnv) == 0 && len(file.ConfigTrusted) == 0 {
		return A2APeerAllow
	}
	trusted := file.ConfigTrusted
	if strings.TrimSpace(file.TrustedPeersEnv) != "" {
		var err error
		trusted, err = parseA2ATrustedPeerEnv(file.TrustedPeersEnv)
		if err != nil {
			return A2APeerDeny
		}
	}
	if a2aContainsString(trusted, name) {
		return A2APeerAllow
	}
	return A2APeerDeny
}

func (h *a2aPolicyHost) verifyPeer(ctx context.Context, file a2aPolicyFileState, process a2aPolicyProcessState, name string, token string, expected A2APeerAccess) bool {
	if h.cfg.ProbePeer == nil || !process.Known || !process.Running || token == "" || !a2aContainsString(process.PeerNames, name) {
		return false
	}
	result, err := h.cfg.ProbePeer(ctx, name, token, expected)
	return err == nil && probeMatches(result, expected)
}

func validateA2APolicyProcessState(state a2aPolicyProcessState) error {
	if !state.Known {
		return nil
	}
	if len(state.PeerNames) > maxA2APolicyPeers || len(state.TrustedPeers) > maxA2APolicyPeers || len(state.Generation) > 128 || state.Running && state.Generation == "" {
		return errors.New("process policy snapshot exceeds bounds")
	}
	peers, err := normalizeA2ATrustedPeers(state.PeerNames)
	if err != nil || !equalStrings(peers, state.PeerNames) {
		return errors.New("process peer inventory is invalid")
	}
	trusted, err := normalizeA2ATrustedPeers(state.TrustedPeers)
	if err != nil || !equalStrings(trusted, state.TrustedPeers) {
		return errors.New("process trust inventory is invalid")
	}
	if state.TrustedPeersOverride && len(state.TrustedPeers) == 0 {
		return errors.New("empty trusted-peer override is not active upstream")
	}
	return nil
}

func parseA2ABool(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

func a2aContainsString(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

func a2aPeerToken(raw, name string) (string, bool) {
	credentials, err := parseA2APeerTokens(raw)
	if err != nil {
		return "", false
	}
	for _, credential := range credentials {
		if credential.name == name {
			return credential.token, true
		}
	}
	return "", false
}

func probeMatches(result a2aPolicyProbeResult, expected A2APeerAccess) bool {
	if expected == A2APeerAllow {
		return result.verdict == a2aPolicyProbeAllowed && result.code == a2aErrTaskNotFound
	}
	// A 401 only establishes that a bearer was not accepted. A configured
	// trusted-peer deny is proven by the pinned 403/A2A untrusted response.
	return expected == A2APeerDeny && result.verdict == a2aPolicyProbeDenied && result.code == a2aErrUntrustedPeer
}

func normalizedOrNil(peers []string) []string {
	if len(peers) == 0 {
		return nil
	}
	return peers
}

func (s a2aPolicyFileState) String() string { return "<A2A policy file state>" }
