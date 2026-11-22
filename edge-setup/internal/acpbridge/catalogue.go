package acpbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// ProtocolCodex selects the Codex App Server dialect; empty means ACP.
const ProtocolCodex = "codex"

// Catalogue is what a local agent offers to this account, read once when the
// connector starts and served as Hermes `/api/model/options`.
type Catalogue struct {
	Provider string
	Name     string
	Models   []AgentModel
	// Version is the agent's own, as it reports it (`hello.engineVersion`).
	Version string
	// ACP `configOptions` ids that carry the choice; empty for Codex.
	ModelOption  string
	EffortOption string
	FastOption   string
	// ModeOption is the ACP permission mode switched to `default` on every
	// turn, so the agent asks before acting instead of following a local
	// `auto` or `bypassPermissions` setting.
	ModeOption string
}

// AgentModel is one model of a Catalogue.
type AgentModel struct {
	ID            string
	Default       bool
	DefaultEffort string
	Efforts       []string
	Fast          bool
}

// turnChoice is a run's model choice, validated against the catalogue.
// Every field is sent on every turn: agents keep a choice for the next turns.
type turnChoice struct {
	Model  *AgentModel
	Effort string
	// EffortChosen: the run asked for Effort; otherwise it is the model default.
	EffortChosen bool
	Fast         bool
}

func (b *Bridge) codex() bool { return b.opts.Protocol == ProtocolCodex }

// catalogueOptions is the catalogue in the shape of Hermes `/api/model/options`.
func (b *Bridge) catalogueOptions() map[string]any {
	c := b.opts.Catalogue
	ids := make([]string, 0, len(c.Models))
	capabilities := map[string]any{}
	current := ""
	for _, model := range c.Models {
		ids = append(ids, model.ID)
		capabilities[model.ID] = map[string]any{"reasoning": len(model.Efforts) > 0, "fast": model.Fast, "efforts": model.Efforts}
		if model.Default || current == "" {
			current = model.ID
		}
	}
	return map[string]any{"provider": c.Provider, "model": current, "providers": []any{map[string]any{
		"slug": c.Provider, "name": c.Name, "is_current": true, "authenticated": true, "auth_type": "oauth",
		"models": ids, "capabilities": capabilities,
	}}}
}

// turnChoice validates the run's model choice against the catalogue. An empty
// model is the catalogue default; an absent effort is the model's default.
func (b *Bridge) turnChoice(input runInput) (turnChoice, error) {
	c := b.opts.Catalogue
	if input.Provider != "" && input.Provider != c.Provider {
		return turnChoice{}, fmt.Errorf("%s does not serve provider %q", c.Name, input.Provider)
	}
	var model *AgentModel
	for index := range c.Models {
		candidate := &c.Models[index]
		if candidate.ID == input.Model || (input.Model == "" && (model == nil || candidate.Default)) {
			model = candidate
		}
	}
	if model == nil {
		return turnChoice{}, fmt.Errorf("%s does not offer model %q on this machine", c.Name, input.Model)
	}
	choice := turnChoice{Model: model, Effort: model.DefaultEffort}
	for name, value := range input.ModelOptions {
		switch name {
		case "prompt_cache_ttl":
		case "reasoning_effort":
			effort, _ := value.(string)
			if !slices.Contains(model.Efforts, effort) {
				return turnChoice{}, fmt.Errorf("%s model %q does not support reasoning effort %q", c.Name, model.ID, effort)
			}
			choice.Effort, choice.EffortChosen = effort, true
		case "fast":
			if value != true {
				continue
			}
			if !model.Fast {
				return turnChoice{}, fmt.Errorf("%s model %q has no Fast mode", c.Name, model.ID)
			}
			choice.Fast = true
		default:
			return turnChoice{}, fmt.Errorf("%s does not support model option %q", c.Name, name)
		}
	}
	return choice, nil
}

type configOption struct {
	ID       string `json:"id"`
	ConfigID string `json:"configId"`
	Category string `json:"category"`
	Current  any    `json:"currentValue"`
	Options  []struct {
		Value any    `json:"value"`
		ID    string `json:"id"`
	} `json:"options"`
}

func (o configOption) key() string {
	if o.ID != "" {
		return o.ID
	}
	return o.ConfigID
}

func (o configOption) values() []string {
	values := []string{}
	for _, option := range o.Options {
		value, _ := option.Value.(string)
		if value == "" {
			value = option.ID
		}
		// `default` names the agent's own setting, not a choice of its own.
		if value != "" && value != "default" {
			values = append(values, value)
		}
	}
	return values
}

func findOption(options []configOption, category, id string) *configOption {
	for index := range options {
		if options[index].Category == category && (id == "" || options[index].key() == id) {
			return &options[index]
		}
	}
	return nil
}

// applyACPChoice sends the turn's model, effort, speed and permission mode to
// the session. The effort is skipped when the chosen model offers no effort.
// It returns whether the session now holds an effort the bot chose.
func (b *Bridge) applyACPChoice(client *rpcClient, sessionID string, choice turnChoice, effortSet bool) (bool, error) {
	c := b.opts.Catalogue
	set := func(id, value string) ([]configOption, error) {
		var result struct {
			ConfigOptions []configOption `json:"configOptions"`
		}
		if err := b.setupCall(client, "session/set_config_option", map[string]any{"sessionId": sessionID, "configId": id, "value": value}, &result); err != nil {
			return nil, fmt.Errorf("%s refused %s %q", c.Name, id, value)
		}
		return result.ConfigOptions, nil
	}
	if c.ModeOption != "" {
		if _, err := set(c.ModeOption, "default"); err != nil {
			return effortSet, err
		}
	}
	options, err := set(c.ModelOption, choice.Model.ID)
	if err != nil {
		return effortSet, err
	}
	// A model without the effort switch has no effort to set; one that offers
	// other levels refuses the turn rather than running at a level nobody
	// chose. With no effort chosen, the model keeps its own default, unless
	// an earlier turn of this session set one: that one is reset.
	if !choice.EffortChosen && !effortSet {
		choice.Effort = ""
	}
	if c.EffortOption != "" && choice.Effort != "" {
		effort := findOption(options, "thought_level", c.EffortOption)
		offered := len(options) == 0 || (effort != nil && slices.Contains(effort.values(), choice.Effort))
		if !offered && effort != nil && choice.EffortChosen {
			return effortSet, fmt.Errorf("%s model %q does not support reasoning effort %q", c.Name, choice.Model.ID, choice.Effort)
		}
		if offered {
			if _, err := set(c.EffortOption, choice.Effort); err != nil {
				return effortSet, err
			}
			effortSet = choice.EffortChosen
		}
	}
	// The model just set may drop the speed switch (Claude's `haiku`): then
	// there is nothing to turn off, and Fast cannot be had.
	if c.FastOption != "" && (len(options) == 0 || findOption(options, "model_config", c.FastOption) != nil) {
		fast := "off"
		if choice.Fast {
			fast = "on"
		}
		if _, err := set(c.FastOption, fast); err != nil {
			return effortSet, err
		}
	} else if choice.Fast {
		return effortSet, fmt.Errorf("%s model %q has no Fast mode", c.Name, choice.Model.ID)
	}
	return effortSet, nil
}

// ErrLoginRequired means the agent runs but its CLI is not logged in.
var ErrLoginRequired = errors.New("login required")

// ProbeACP starts an ACP agent, opens and closes one session in the workspace
// and returns its catalogue: the `model` option, plus the `thought_level` and
// `fast` options when the agent has them.
func ProbeACP(ctx context.Context, command string, args, env []string, workspace, provider, name string) (*Catalogue, error) {
	client, err := startRPC(command, args, env, workspace, false, 4, 5*time.Second, func(*rpcClient, rpcMessage) {})
	if err != nil {
		return nil, fmt.Errorf("could not start %s", name)
	}
	defer client.stop()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var init struct {
		Version   int `json:"protocolVersion"`
		AgentInfo struct {
			Version string `json:"version"`
		} `json:"agentInfo"`
		Meta struct {
			AgentVersion string `json:"agentVersion"`
		} `json:"_meta"`
	}
	if err := client.call(ctx, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{"fs": map[string]bool{"readTextFile": false, "writeTextFile": false}, "terminal": false}}, &init); err != nil || init.Version != 1 {
		return nil, fmt.Errorf("%s did not answer the Agent Client Protocol", name)
	}
	var session struct {
		SessionID     string         `json:"sessionId"`
		ConfigOptions []configOption `json:"configOptions"`
	}
	if err := client.call(ctx, "session/new", map[string]any{"cwd": workspace, "mcpServers": []any{}}, &session); err != nil {
		if strings.Contains(err.Error(), "error -32000") {
			return nil, ErrLoginRequired
		}
		return nil, fmt.Errorf("%s could not open a session", name)
	}
	var closed json.RawMessage
	_ = client.call(ctx, "session/close", map[string]string{"sessionId": session.SessionID}, &closed)
	c, err := catalogueFromOptions(session.ConfigOptions, provider, name)
	if err != nil {
		return nil, err
	}
	c.Version = init.AgentInfo.Version
	if c.Version == "" {
		c.Version = init.Meta.AgentVersion
	}
	return c, nil
}

func catalogueFromOptions(options []configOption, provider, name string) (*Catalogue, error) {
	model := findOption(options, "model", "")
	if model == nil || len(model.values()) == 0 {
		return nil, fmt.Errorf("%s does not list its models", name)
	}
	c := &Catalogue{Provider: provider, Name: name, ModelOption: model.key()}
	var efforts []string
	defaultEffort := ""
	if effort := findOption(options, "thought_level", ""); effort != nil {
		c.EffortOption = effort.key()
		efforts = effort.values()
		if current, _ := effort.Current.(string); slices.Contains(efforts, current) {
			defaultEffort = current
		}
	}
	if fast := findOption(options, "model_config", "fast"); fast != nil {
		c.FastOption = fast.key()
	}
	if mode := findOption(options, "mode", ""); mode != nil && hasValue(mode, "default") {
		c.ModeOption = mode.key()
	}
	current, _ := model.Current.(string)
	for _, id := range model.values() {
		c.Models = append(c.Models, AgentModel{ID: id, Default: id == current, DefaultEffort: defaultEffort, Efforts: efforts, Fast: c.FastOption != ""})
	}
	return c, nil
}

func hasValue(o *configOption, value string) bool {
	for _, option := range o.Options {
		if v, _ := option.Value.(string); v == value || option.ID == value {
			return true
		}
	}
	return false
}
