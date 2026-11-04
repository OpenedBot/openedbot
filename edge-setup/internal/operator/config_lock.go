package operator

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

// rootConfig is the lock key of the runtime root's config.yaml; a named
// profile's config.yaml is keyed by its slug.
const rootConfig = ""

// configRootWriteVerbs read, change and rewrite the runtime root's
// config.yaml.
var configRootWriteVerbs = map[string]bool{"mcp-add": true, "mcp-install": true, "mcp-remove": true}

// configProfileWriteVerbs read, change and rewrite the config.yaml of the
// profile their request names: "name", or every entry of "names".
var configProfileWriteVerbs = map[string]bool{
	"profile-create":             true,
	"profile-delete":             true,
	"profile-model-set":          true,
	"profile-models-set":         true,
	"profile-mcp-set":            true,
	"profile-mcp-remove":         true,
	"profile-memory-set":         true,
	"profile-toolset-suppress":   true,
	"profile-skill-set":          true,
	"profile-bundled-skills-set": true,
}

// configNeutralWriteVerbs write something else than a config.yaml: memory
// files, .env (serialised by credBusy), auth stores, the skills tree. Every
// write verb is in exactly one of the three sets (config_lock_test.go), so a
// new one has to be classified before it ships.
var configNeutralWriteVerbs = map[string]bool{
	"profile-memory-write":      true,
	"profile-credential-set":    true,
	"profile-credential-delete": true,
	"profile-oauth-adopt-root":  true,
	"skills-hub-refresh":        true,
	"skills-hub-install":        true,
	"skills-hub-uninstall":      true,
	"skills-hub-scan":           true,
	"skills-hub-search":         true,
	"skills-hub-inspect":        true,
	"skills-hub-capabilities":   true,
	"profile-memory-get":        true,
	"profile-avatar":            true,
}

// configWriteTargets lists the config files verb rewrites, by lock key.
func configWriteTargets(verb string, request any) []string {
	switch {
	case configRootWriteVerbs[verb]:
		return []string{rootConfig}
	case configProfileWriteVerbs[verb]:
		encoded, err := json.Marshal(request)
		if err != nil {
			return nil
		}
		var names struct {
			Name  string   `json:"name"`
			Names []string `json:"names"`
		}
		_ = json.Unmarshal(encoded, &names)
		if names.Name != "" {
			return []string{names.Name}
		}
		return names.Names
	}
	return nil
}

// lockConfigs takes the lock of every named config file, in a fixed order so
// that two batches over the same profiles cannot deadlock, and returns the
// function that releases them. Each lock covers one whole read, change and
// rewrite of its file: Hermes saves the document it read, so two writers
// interleaved on the same file silently lose one of the changes, whatever
// part of the file each one meant to touch. It waits rather than refusing,
// and gives up only when ctx ends.
func (s *Server) lockConfigs(ctx context.Context, keys ...string) (func(), error) {
	keys = slices.Clone(keys)
	slices.Sort(keys)
	keys = slices.Compact(keys)
	held := make([]chan struct{}, 0, len(keys))
	release := func() {
		for i := len(held) - 1; i >= 0; i-- {
			<-held[i]
		}
	}
	for _, key := range keys {
		s.mu.Lock()
		if s.configLocks == nil {
			s.configLocks = map[string]chan struct{}{}
		}
		lock := s.configLocks[key]
		if lock == nil {
			lock = make(chan struct{}, 1)
			s.configLocks[key] = lock
		}
		s.mu.Unlock()
		select {
		case lock <- struct{}{}:
			held = append(held, lock)
		case <-ctx.Done():
			release()
			return nil, ctx.Err()
		}
	}
	return release, nil
}

// withConfigLock runs write, which rewrites the config file keyed by key,
// under that file's lock.
func (s *Server) withConfigLock(ctx context.Context, key string, write func() error) error {
	unlock, err := s.lockConfigs(ctx, key)
	if err != nil {
		return err
	}
	defer unlock()
	return write()
}

// runConfigWriter runs a command that rewrites the config file keyed by key
// (a `hermes tools` change) under that file's lock.
func (s *Server) runConfigWriter(ctx context.Context, key string, cmd exec.Cmd) error {
	return s.withConfigLock(ctx, key, func() error {
		_, err := exec.Must(ctx, s.Runner, cmd)
		return err
	})
}

// lockedApprovalPolicyWrite runs the approval policy write, which enables its
// plugin in the profile's config.yaml, under that file's lock.
func (s *Server) lockedApprovalPolicyWrite() func(context.Context, string, approvalPolicyRequest) (approvalPolicyState, error) {
	write := s.ApprovalPolicyWrite
	if write == nil {
		return nil
	}
	return func(ctx context.Context, slug string, request approvalPolicyRequest) (state approvalPolicyState, err error) {
		err = s.withConfigLock(ctx, slug, func() error {
			state, err = write(ctx, slug, request)
			return err
		})
		return state, err
	}
}
