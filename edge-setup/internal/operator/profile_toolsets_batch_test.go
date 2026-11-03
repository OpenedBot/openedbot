package operator

import (
	"context"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

// batchServer is an operator whose profile reads back `profileInventory` and
// whose probe answers `replies`; it records every probe verb and body.
func batchServer(t *testing.T, replies map[string]string, profileInventory func() string, onProbe ...func(verb string)) (*exectest.Fake, *[]string, *[]string, *httptest.Server) {
	t.Helper()
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{})
	var verbs, bodies []string
	s := &Server{
		Runner: fake,
		Probe: func(_ context.Context, verb string, request []byte) ([]byte, error) {
			verbs = append(verbs, verb)
			bodies = append(bodies, string(request))
			for _, hook := range onProbe {
				hook(verb)
			}
			if reply, ok := replies[verb]; ok {
				return []byte(reply), nil
			}
			return []byte(`{"error":{"code":"HOST_FAILED","message":"no reply"}}`), nil
		},
		Inventory: func(context.Context) ([]byte, error) { return []byte(`{"data":[]}`), nil },
		ProfileInventory: func(context.Context, string) ([]byte, error) {
			return []byte(profileInventory()), nil
		},
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return fake, &verbs, &bodies, srv
}

func TestProfileToolsetsBatchWritesEachDirectionInOneCLICall(t *testing.T) {
	replies := map[string]string{
		"toolsets":           `{"platform":"api_server","settable":["browser","file","memory","terminal","web"]}`,
		"profile-memory-set": `{"profile":"scout","memoryEnabled":false,"userProfileEnabled":false}`,
	}
	reads := 0
	fake, verbs, bodies, srv := batchServer(t, replies, func() string {
		reads++
		return `{"data":[{"name":"web","enabled":true},{"name":"file","enabled":true},{"name":"browser","enabled":false},{"name":"terminal","enabled":false},{"name":"memory","enabled":false}]}`
	})

	status, out := call(t, srv, "POST", "/profiles/scout/toolsets",
		`{"toolsets":{"web":true,"terminal":false,"file":true,"browser":false,"memory":false}}`)
	if status != 200 || out["profile"] != "scout" || out["platform"] != "api_server" {
		t.Fatalf("batch %d %v", status, out)
	}
	commands := fake.Commands()
	if len(fake.Calls) != 2 ||
		!strings.Contains(fake.Calls[0].String(), "hermes -p scout tools enable file web --platform api_server") ||
		!strings.Contains(fake.Calls[1].String(), "hermes -p scout tools disable browser memory terminal --platform api_server") {
		t.Fatalf("argv %v", commands)
	}
	toolsets, _ := out["toolsets"].([]any)
	if len(toolsets) != 5 {
		t.Fatalf("states %v", out)
	}
	for _, raw := range toolsets {
		state, _ := raw.(map[string]any)
		if state["applied"] != true || state["profile"] != "scout" || state["enabled"] != state["requested"] {
			t.Fatalf("state %v", state)
		}
	}
	if first, _ := toolsets[0].(map[string]any); first["name"] != "browser" {
		t.Fatalf("states are not in name order: %v", toolsets)
	}
	// One settable read and ONE read-back for the whole batch, and the memory
	// flags follow the toggle.
	if reads != 1 {
		t.Fatalf("the batch read the profile inventory %d times", reads)
	}
	if count(*verbs, "toolsets") != 1 {
		t.Fatalf("probes %v", *verbs)
	}
	memory := slices.Index(*verbs, "profile-memory-set")
	if memory < 0 || !strings.Contains((*bodies)[memory], `"enabled":false`) {
		t.Fatalf("memory flags probe %v %v", *verbs, *bodies)
	}
}

func TestProfileToolsetsBatchOnlyEnablingMakesOneCLICall(t *testing.T) {
	replies := map[string]string{"toolsets": settableWebBrowser}
	fake, _, _, srv := batchServer(t, replies, func() string {
		return `{"data":[{"name":"web","enabled":true},{"name":"browser","enabled":true}]}`
	})
	status, out := call(t, srv, "POST", "/profiles/scout/toolsets", `{"toolsets":{"web":true,"browser":true}}`)
	if status != 200 || len(fake.Calls) != 1 || !strings.Contains(fake.Calls[0].String(), "tools enable browser web --platform api_server") {
		t.Fatalf("%d %v %v", status, out, fake.Commands())
	}
}

func TestProfileToolsetsBatchRefusesTheWholeBatchBeforeAnyWrite(t *testing.T) {
	replies := map[string]string{"toolsets": settableWebBrowser}
	fake, verbs, _, srv := batchServer(t, replies, func() string { return `{"data":[]}` })

	cases := []struct {
		body   string
		status int
		code   string
	}{
		{`{"toolsets":{"web":true,"cronjob":true}}`, 403, "TOOLSET_FORBIDDEN"},
		{`{"toolsets":{"web":true,"image_gen":false}}`, 404, "TOOLSET_NOT_SETTABLE"},
		{`{"toolsets":{"Web":true}}`, 400, "TOOLSET_INVALID"},
		{`{"toolsets":{"web":null}}`, 400, "BODY_INVALID"},
		{`{"toolsets":{}}`, 400, "BODY_INVALID"},
		{`{"toolsets":{"web":true},"extra":1}`, 400, "BODY_INVALID"},
	}
	for _, c := range cases {
		status, out := call(t, srv, "POST", "/profiles/scout/toolsets", c.body)
		if status != c.status || errorCode(out) != c.code {
			t.Fatalf("%s: %d %v", c.body, status, out)
		}
	}
	status, out := call(t, srv, "POST", "/profiles/default/toolsets", `{"toolsets":{"web":true}}`)
	if status != 400 || errorCode(out) != "PROFILE_INVALID" {
		t.Fatalf("default profile %d %v", status, out)
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("a refused batch reached the CLI: %v", fake.Commands())
	}
	// Disabling a forbidden toolset stays possible, as on the single route.
	if slices.Contains(*verbs, "profile-memory-set") {
		t.Fatalf("probes %v", *verbs)
	}
}

func TestProfileToolsetsBatchFallsBackToSuppressionPerToolset(t *testing.T) {
	suppressed := false
	replies := map[string]string{
		"toolsets":                 `{"platform":"api_server","settable":["x_search","web"]}`,
		"profile-toolset-suppress": `{"profile":"ohb-reviewer","toolset":"x_search","suppressed":true}`,
	}
	// The platform list never moves x_search; the suppression does, as the
	// real probe would.
	fake, verbs, bodies, srv := batchServer(t, replies, func() string {
		xSearch := "true"
		if suppressed {
			xSearch = "false"
		}
		return `{"data":[{"name":"x_search","enabled":` + xSearch + `},{"name":"web","enabled":false}]}`
	}, func(verb string) {
		if verb == "profile-toolset-suppress" {
			suppressed = true
		}
	})

	status, out := call(t, srv, "POST", "/profiles/ohb-reviewer/toolsets", `{"toolsets":{"x_search":false,"web":false}}`)
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	at := slices.Index(*verbs, "profile-toolset-suppress")
	if at < 0 || !strings.Contains((*bodies)[at], `"toolset":"x_search"`) || !strings.Contains((*bodies)[at], `"suppressed":true`) {
		t.Fatalf("suppression probe %v %v", *verbs, *bodies)
	}
	if count(*verbs, "profile-toolset-suppress") != 1 {
		t.Fatalf("only the toolset that did not move is suppressed: %v", *verbs)
	}
	if len(fake.Calls) != 1 || !strings.Contains(fake.Calls[0].String(), "tools disable web x_search --platform api_server") {
		t.Fatalf("argv %v", fake.Commands())
	}
	toolsets, _ := out["toolsets"].([]any)
	if len(toolsets) != 2 {
		t.Fatalf("states %v", out)
	}
	for _, raw := range toolsets {
		state, _ := raw.(map[string]any)
		if state["applied"] != true || state["enabled"] != false {
			t.Fatalf("state %v", state)
		}
	}
}

func count(values []string, wanted string) int {
	n := 0
	for _, value := range values {
		if value == wanted {
			n++
		}
	}
	return n
}
