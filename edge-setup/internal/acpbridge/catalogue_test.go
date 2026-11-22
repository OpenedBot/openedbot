package acpbridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

func fakeAgentArgs(scenario string) []string {
	return []string{"-test.run=^TestACPAgent$", "--", "--acp-fake", scenario}
}

func TestProbeACPReadsTheCatalogue(t *testing.T) {
	c, err := ProbeACP(context.Background(), os.Args[0], fakeAgentArgs("catalogue"), os.Environ(), t.TempDir(), "fake", "Fake CLI")
	if err != nil {
		t.Fatal(err)
	}
	if c.ModelOption != "model" || c.EffortOption != "effort" || c.FastOption != "fast" || c.ModeOption != "mode" {
		t.Fatalf("options: %+v", c)
	}
	want := []AgentModel{
		{ID: "fake-pro", Default: true, DefaultEffort: "medium", Efforts: []string{"low", "medium", "high"}, Fast: true},
		{ID: "fake-mini", DefaultEffort: "medium", Efforts: []string{"low", "medium", "high"}, Fast: true},
		{ID: "fake-lite", DefaultEffort: "medium", Efforts: []string{"low", "medium", "high"}, Fast: true},
	}
	if !reflect.DeepEqual(c.Models, want) {
		t.Fatalf("models: %+v", c.Models)
	}
	if _, err := ProbeACP(context.Background(), os.Args[0], fakeAgentArgs("catalogue-login"), os.Environ(), t.TempDir(), "fake", "Fake CLI"); !errors.Is(err, ErrLoginRequired) {
		t.Fatalf("login: %v", err)
	}
}

// Every turn sends the permission mode, the model, the effort (only when the
// model still offers one) and the speed, so no choice sticks to the session.
func TestACPChoiceIsSentEveryTurn(t *testing.T) {
	f := newFixture(t, "basic")
	f.opts.Catalogue, _ = catalogueFromOptions(decodeOptions(t), "fake", "Fake CLI")
	f.restart()
	f.session("session")
	body := input("session")
	body["provider"], body["model"] = "fake", "fake-pro"
	body["model_options"] = map[string]any{"reasoning_effort": "high", "fast": true}
	if got := configCalls(t, f, f.run(body, "chosen")); got != "mode=default model=fake-pro effort=high fast=on" {
		t.Fatalf("chosen turn: %s", got)
	}
	body["model"], body["model_options"] = "fake-mini", map[string]any{}
	if got := configCalls(t, f, f.run(body, "mini")); got != "mode=default model=fake-mini" {
		t.Fatalf("model without effort: %s", got)
	}
	// Fast asked on a model that dropped it fails the turn instead of running slow.
	body["model_options"] = map[string]any{"fast": true}
	run := f.run(body, "mini-fast")
	f.await(run, "run.failed")
	// On a model with other levels, the default effort is left to the model,
	// but an effort the bot chose is never swapped for another one.
	body["model"], body["model_options"] = "fake-lite", map[string]any{}
	if got := configCalls(t, f, f.run(body, "lite")); got != "mode=default model=fake-lite fast=off" {
		t.Fatalf("default effort on fake-lite: %s", got)
	}
	body["model_options"] = map[string]any{"reasoning_effort": "high"}
	f.await(f.run(body, "lite-high"), "run.failed")
	// A new session with no effort chosen leaves the model on its own default.
	f.session("fresh")
	fresh := input("fresh")
	fresh["provider"], fresh["model"] = "fake", "fake-pro"
	if got := configCalls(t, f, f.run(fresh, "fresh")); got != "mode=default model=fake-pro fast=off" {
		t.Fatalf("fresh session: %s", got)
	}
}

func decodeOptions(t *testing.T) []configOption {
	raw, _ := json.Marshal(fakeConfigOptions("fake-pro"))
	var options []configOption
	if err := json.Unmarshal(raw, &options); err != nil {
		t.Fatal(err)
	}
	return options
}

// configCalls reads the fake agent's trace of this turn's set_config_option calls.
func configCalls(t *testing.T, f *fixture, run string) string {
	t.Helper()
	chunk := f.await(run, "message.delta")
	var answer struct {
		Trace []rpcMessage `json:"trace"`
	}
	if err := json.Unmarshal([]byte(chunk["delta"].(string)), &answer); err != nil {
		t.Fatal(err)
	}
	// The calls made since the previous prompt, up to this turn's prompt.
	var calls, turn []string
	for _, m := range answer.Trace {
		if m.Method == "session/prompt" {
			turn, calls = calls, nil
		}
		if m.Method != "session/set_config_option" {
			continue
		}
		var p struct {
			ConfigID string `json:"configId"`
			Value    string `json:"value"`
		}
		_ = json.Unmarshal(m.Params, &p)
		// Every turn starts with the permission mode: a turn that failed
		// before its prompt leaves no calls in the next one's window.
		if p.ConfigID == "mode" {
			calls = nil
		}
		calls = append(calls, p.ConfigID+"="+p.Value)
	}
	return strings.Join(turn, " ")
}

// An effort the bot chose survives a bridge restart: an agent that restores
// its session on `session/load` keeps it, so the next default turn resets it.
func TestACPChosenEffortIsResetAfterRestart(t *testing.T) {
	f := newFixture(t, "load")
	f.opts.Catalogue, _ = catalogueFromOptions(decodeOptions(t), "fake", "Fake CLI")
	f.restart()
	f.session("session")
	body := input("session")
	body["provider"], body["model"] = "fake", "fake-pro"
	body["model_options"] = map[string]any{"reasoning_effort": "high"}
	if got := configCalls(t, f, f.run(body, "chosen")); got != "mode=default model=fake-pro effort=high fast=off" {
		t.Fatalf("chosen: %s", got)
	}
	f.restart()
	body["model_options"] = map[string]any{}
	if got := configCalls(t, f, f.run(body, "after-restart")); got != "mode=default model=fake-pro effort=medium fast=off" {
		t.Fatalf("after restart: %s", got)
	}
}
