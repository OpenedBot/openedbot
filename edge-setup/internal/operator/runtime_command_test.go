package operator

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

func TestHostLocalCLIReceivesCredentialThroughStdinAndIsVerified(t *testing.T) {
	s, runner, srv := newServer(t, catalogueOK)
	s.HermesCommand = fixtureUserCLI
	runner.OnPrefix("/fixture/user/venv/bin/hermes", exec.Result{})
	status, body := call(t, srv, "POST", "/providers/anthropic/credentials", `{"apiKey":"fixture-secret","label":"fixture"}`)
	if status != 200 || body["verification"] != "confirmed" {
		t.Fatalf("status=%d body=%v", status, body)
	}
	if len(runner.Calls) != 1 {
		t.Fatalf("commands=%v", runner.Commands())
	}
	cmd := runner.Calls[0]
	if cmd.Path != "/fixture/user/venv/bin/hermes" || !reflect.DeepEqual(cmd.Args, []string{"auth", "add", "anthropic", "--type", "api-key", "--label", "fixture"}) {
		t.Fatalf("host-local command not used: %v", cmd)
	}
	if string(cmd.Stdin) != "fixture-secret\n" || strings.Contains(cmd.String(), "fixture-secret") || strings.Contains(strings.Join(cmd.Env, " "), "fixture-secret") {
		t.Fatal("credential left stdin")
	}
}

func TestProfileCredentialUsesHostLocalCLIAndExactProfile(t *testing.T) {
	s, runner, srv := newServer(t, catalogueOK)
	s.HermesCommand = fixtureUserCLI
	runner.OnPrefix("/fixture/user/venv/bin/hermes", exec.Result{})
	s.ProfileCatalogue = func(_ context.Context, profile string) ([]byte, error) {
		if profile != "scout" {
			t.Errorf("verified profile=%q", profile)
		}
		return []byte(catalogueOK), nil
	}
	status, body := call(t, srv, "POST", "/profiles/scout/providers/anthropic/credentials", `{"apiKey":"fixture-secret","label":"fixture"}`)
	if status != 200 || body["verification"] != "confirmed" {
		t.Fatalf("status=%d body=%v", status, body)
	}
	if len(runner.Calls) != 1 {
		t.Fatalf("commands=%v", runner.Commands())
	}
	cmd := runner.Calls[0]
	if cmd.Path != "/fixture/user/venv/bin/hermes" || !reflect.DeepEqual(cmd.Args, []string{"-p", "scout", "auth", "add", "anthropic", "--type", "api-key", "--label", "fixture"}) {
		t.Fatalf("profile command=%v", cmd)
	}
	if string(cmd.Stdin) != "fixture-secret\n" {
		t.Fatal("profile credential missing from stdin")
	}
}

func fixtureUserCLI(args ...string) exec.Cmd {
	return exec.Cmd{Path: "/fixture/user/venv/bin/hermes", Args: append([]string(nil), args...), Env: []string{"HERMES_HOME=/fixture/user/runtime", "PATH=/fixture/user/venv/bin:/usr/bin:/bin"}}
}
