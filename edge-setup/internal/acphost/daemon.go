package acphost

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/acpbridge"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

// Options keeps credentials out of argv and never imports the supervisor's
// environment. The root-owned HOME prevents user agent/plugin configuration
// from overriding the mandatory permission policy.
func Options(p Paths, st *state.File, credentialDir string, owner fsx.Owner) (acpbridge.Options, error) {
	if st.EngineName() != state.EngineOpenCode {
		return acpbridge.Options{}, errors.New("acp-bridge requires an acp:opencode host")
	}
	if credentialDir == "" {
		return acpbridge.Options{}, errors.New("acp-bridge requires systemd credentials")
	}
	data, err := os.ReadFile(filepath.Join(credentialDir, "runtime.env"))
	if err != nil {
		return acpbridge.Options{}, fmt.Errorf("runtime.env credential: %w", err)
	}
	token := hermes.ReadToken(string(data))
	if token == "" {
		return acpbridge.Options{}, errors.New("runtime.env credential carries no API_SERVER_KEY")
	}
	values, err := hermes.ReadPrivateEnv(p.Credentials, owner)
	if err != nil {
		return acpbridge.Options{}, err
	}
	// Only provider credentials are accepted. Loader, proxy and OpenCode control
	// variables cannot enter through the credential file.
	allowed := map[string]bool{"OPENAI_API_KEY": true, "ANTHROPIC_API_KEY": true, "GOOGLE_GENERATIVE_AI_API_KEY": true, "GEMINI_API_KEY": true, "OPENCODE_API_KEY": true, "OPENROUTER_API_KEY": true, "AWS_ACCESS_KEY_ID": true, "AWS_SECRET_ACCESS_KEY": true, "AWS_SESSION_TOKEN": true, "AWS_REGION": true}
	spec := agentCommand(p, "acp")
	env := spec.Env
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !allowed[key] {
			return acpbridge.Options{}, fmt.Errorf("unsupported agent credential variable %s", key)
		}
		if strings.Contains(values[key], token) {
			return acpbridge.Options{}, errors.New("agent credential contains the gateway bearer")
		}
		env = append(env, key+"="+values[key])
	}
	config := filepath.Join(p.Config, "opencode.json")
	configData, err := fsx.ReadRegular(config, 0o644, owner)
	if err != nil {
		return acpbridge.Options{}, err
	}
	env = append(env, "OPENCODE_CONFIG_CONTENT="+string(configData))

	return acpbridge.Options{ListenAddress: net.JoinHostPort(layout.GatewayHost, strconv.Itoa(layout.GatewayPort)), Bearer: token, StateDirectory: p.State, ProfilesRoot: p.Profiles, AgentCommand: spec.Path, AgentArguments: spec.Args, AgentEnvironmentValues: env}, nil
}

// agentCommand is shared by the install version proof and the live agent.
// OpenCode appends /opencode to XDG_CONFIG_HOME, so its parent must be used.
func agentCommand(p Paths, args ...string) exec.Cmd {
	spec := account.AsUser(layout.ServiceUser, []string{
		"HOME=" + filepath.Join(p.Config, "home"),
		"XDG_CONFIG_HOME=" + filepath.Dir(p.Config),
		"XDG_DATA_HOME=" + filepath.Join(p.Runtime, "acp-home", "data"),
		"XDG_CACHE_HOME=" + filepath.Join(p.Runtime, "acp-home", "cache"),
		"XDG_STATE_HOME=" + filepath.Join(p.Runtime, "acp-home", "state"),
		"OPENCODE_CONFIG=" + filepath.Join(p.Config, "opencode.json"),
		"OPENCODE_CONFIG_DIR=" + p.Config,
		"OPENCODE_DISABLE_PROJECT_CONFIG=true",
	}, filepath.Join(p.Agent, "opencode"), args...)
	spec.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"}
	return spec
}
