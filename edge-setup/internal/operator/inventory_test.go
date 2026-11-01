package operator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

// probeRecorder answers the inventory verbs from a table and records what it
// was asked, so a test can prove the request never carried a secret in argv.
type probeRecorder struct {
	replies map[string]string
	seen    []string
	bodies  []string
}

func (p *probeRecorder) probe() Probe {
	return func(_ context.Context, verb string, request []byte) ([]byte, error) {
		p.seen = append(p.seen, verb)
		p.bodies = append(p.bodies, string(request))
		reply, ok := p.replies[verb]
		if !ok {
			return []byte(`{"error":{"code":"HOST_FAILED","message":"no reply"}}`), nil
		}
		return []byte(reply), nil
	}
}

func inventoryServer(t *testing.T, replies map[string]string, inventory string, cli ...exec.Result) (*probeRecorder, *exectest.Fake, *httptest.Server) {
	t.Helper()
	fake := exectest.NewFake()
	result := exec.Result{}
	if len(cli) > 0 {
		result = cli[0]
	}
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", result)
	recorder := &probeRecorder{replies: replies}
	s := &Server{
		Runner: fake,
		Probe:  recorder.probe(),
		Inventory: func(context.Context) ([]byte, error) {
			return []byte(inventory), nil
		},
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return recorder, fake, srv
}

const settableWebBrowser = `{"platform":"api_server","settable":["browser","web"]}`

func TestCapabilitiesAnnounceOnlyWhatTheHostCanServe(t *testing.T) {
	// No probe: the two provider features only. A page that saw
	// toolset_management here would render a toggle whose write must fail.
	bare := &Server{}
	if got := bare.features(); len(got) != 2 {
		t.Fatalf("features %v", got)
	}
	// A probe without a gateway reader cannot PROVE a toolset write, so it
	// serves MCP and the profile inventory, and stays silent about toolsets.
	partial := &Server{Probe: (&probeRecorder{}).probe()}
	if got := partial.features(); len(got) != 5 || got[2] != "mcp_management" || got[3] != "profile_inventory" || got[4] != "model_context" {
		t.Fatalf("features %v", got)
	}
	_, _, srv := inventoryServer(t, nil, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/capabilities", "")
	features, _ := out["features"].([]any)
	if status != 200 || len(features) != 6 {
		t.Fatalf("%d %v", status, out)
	}
	profiled := &Server{Probe: (&probeRecorder{replies: map[string]string{
		"profiles": `{"multiplex":true,"profiles":[]}`,
	}}).probe(), Inventory: func(context.Context) ([]byte, error) {
		return []byte(`{"data":[]}`), nil
	}, Multiplex: true}
	got := profiled.features()
	if !slices.Contains(got, "profile_management") || !slices.Contains(got, "profile_capabilities") || !slices.Contains(got, "profile_bundled_skills") || !slices.Contains(got, "profile_credentials") {
		t.Fatalf("profile features %v", got)
	}
}

func TestProfileBundledSkillsFeatureUsesProfileCapabilityGate(t *testing.T) {
	s := &Server{
		Probe:          (&probeRecorder{}).probe(),
		Inventory:      func(context.Context) ([]byte, error) { return []byte(`{"data":[]}`), nil },
		Multiplex:      true,
		SkillsHubReady: true,
	}
	if !slices.Contains(s.features(), "profile_bundled_skills") {
		t.Fatal("profile_bundled_skills was not announced with profile capabilities")
	}
	s.Inventory = nil
	if slices.Contains(s.features(), "profile_bundled_skills") {
		t.Fatal("profile_bundled_skills was announced without a profile inventory")
	}
}

func TestCapabilitiesRefreshMultiplexWithoutDisablingProfileReadCache(t *testing.T) {
	replies := map[string]string{"profiles": `{"multiplex":true,"profiles":[]}`}
	recorder := &probeRecorder{replies: replies}
	s := &Server{Probe: recorder.probe()}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	status, out := call(t, srv, "GET", "/capabilities", "")
	if status != http.StatusOK || !containsString(out["features"], "profile_management") {
		t.Fatalf("enabled capabilities %d %v", status, out)
	}
	status, out = call(t, srv, "GET", "/profiles", "")
	if status != http.StatusOK || out["multiplex"] != true {
		t.Fatalf("profile read %d %v", status, out)
	}
	replies["profiles"] = `{"multiplex":false,"profiles":[]}`
	status, out = call(t, srv, "GET", "/profiles", "")
	if status != http.StatusOK || out["multiplex"] != true {
		t.Fatalf("pure profile read was not cached %d %v", status, out)
	}
	status, out = call(t, srv, "GET", "/capabilities", "")
	if status != http.StatusOK || containsString(out["features"], "profile_management") {
		t.Fatalf("stale capabilities %d %v", status, out)
	}
	// Two capability reads reread profiles each time; the skills hub probe
	// runs once, lazily, on the first read, and is never repeated.
	want := []string{"profiles", "skills-hub-capabilities", "profiles", "profiles"}
	if strings.Join(recorder.seen, ",") != strings.Join(want, ",") {
		t.Fatalf("capabilities must reread profiles and probe the hub once: %v", recorder.seen)
	}
}

func TestProfileCreateUsesTheLocalGatewayBearerAndReadsBackTheProfile(t *testing.T) {
	replies := map[string]string{
		"profile-create": `{"profile":{"name":"scout"}}`,
		"profiles":       `{"multiplex":true,"profiles":[{"name":"scout","displayName":"Scout"}]}`,
	}
	// The key in the HTTP body is intentionally ignored: the operator reads
	// the local runtime.env bearer and gives that value only to probe stdin.
	recorder := &probeRecorder{replies: replies}
	s := &Server{Probe: recorder.probe(), GatewayToken: func() (string, error) { return "root-bearer", nil }}
	httpSrv := httptest.NewServer(s.Handler())
	defer httpSrv.Close()
	status, out := call(t, httpSrv, "POST", "/profiles", `{"name":"scout","apiServerKey":"attacker-key"}`)
	if status != http.StatusCreated || out["profile"].(map[string]any)["name"] != "scout" {
		t.Fatalf("%d %v", status, out)
	}
	if len(recorder.bodies) != 2 || !strings.Contains(recorder.bodies[0], "root-bearer") || strings.Contains(recorder.bodies[0], "attacker-key") || recorder.bodies[1] != "{}" {
		t.Fatalf("probe bodies %v", recorder.bodies)
	}
}

func TestProfileCreateSpendsNoInventoryReadWhenTheProbeVerifiedTheProfile(t *testing.T) {
	scout := `{"name":"scout","displayName":"Scout","model":{"default":"claude-sonnet-4","provider":"anthropic"}}`
	cases := []struct {
		name       string
		body       string
		create     string
		wantProbes int
		wantMarked bool
	}{
		{"verified", `{"name":"scout","provider":"anthropic","model":"claude-sonnet-4"}`, `{"profile":` + scout + `,"verified":true}`, 1, true},
		{"not verified by the probe", `{"name":"scout","provider":"anthropic","model":"claude-sonnet-4"}`, `{"profile":` + scout + `,"verified":false}`, 2, false},
		{"no marker (older probe)", `{"name":"scout","provider":"anthropic","model":"claude-sonnet-4"}`, `{"profile":` + scout + `}`, 2, false},
		{"another model than requested", `{"name":"scout","provider":"anthropic","model":"claude-opus-4"}`, `{"profile":` + scout + `,"verified":true}`, 2, false},
		{"another name than requested", `{"name":"scout"}`, `{"profile":{"name":"other","displayName":"Other"},"verified":true}`, 2, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &probeRecorder{replies: map[string]string{
				"profile-create": tc.create,
				"profiles":       `{"multiplex":true,"profiles":[` + scout + `]}`,
			}}
			s := &Server{Probe: recorder.probe(), GatewayToken: func() (string, error) { return "root-bearer", nil }}
			httpSrv := httptest.NewServer(s.Handler())
			defer httpSrv.Close()
			status, out := call(t, httpSrv, "POST", "/profiles", tc.body)
			if status != http.StatusCreated {
				t.Fatalf("%d %v", status, out)
			}
			if len(recorder.seen) != tc.wantProbes {
				t.Fatalf("probes %v, want %d", recorder.seen, tc.wantProbes)
			}
			if _, marked := out["readBack"]; marked != tc.wantMarked {
				t.Fatalf("readBack marker %v in %v", marked, out)
			}
		})
	}
}

func TestProfileLifecycleAndCapabilityWrites(t *testing.T) {
	replies := map[string]string{
		"profile-delete":  `{"deleted":"scout"}`,
		"profile-mcp-set": `{"name":"linear","profile":"scout","enabled":false}`,
		"profiles":        `{"multiplex":true,"profiles":[]}`,
		"toolsets":        settableWebBrowser,
	}
	recorder := &probeRecorder{replies: replies}
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{})
	s := &Server{
		Runner: fake,
		Probe:  recorder.probe(),
		Inventory: func(context.Context) ([]byte, error) {
			return []byte(`{"data":[]}`), nil
		},
		ProfileInventory: func(context.Context, string) ([]byte, error) {
			return []byte(`{"data":[{"name":"web","enabled":true}]}`), nil
		},
		GatewayToken: func() (string, error) { return "root-bearer", nil },
	}
	httpSrv := httptest.NewServer(s.Handler())
	defer httpSrv.Close()

	status, out := call(t, httpSrv, "POST", "/profiles/scout/toolsets/web", `{"enabled":true}`)
	if status != http.StatusOK || out["profile"] != "scout" || out["enabled"] != true || out["applied"] != true {
		t.Fatalf("toolset %d %v", status, out)
	}
	if !fake.Ran("/usr/sbin/runuser -u hermes -- /usr/bin/env HERMES_HOME=/srv/hermes/data PATH=/usr/local/lib/hermes-agent/venv/bin:/usr/bin:/bin /usr/local/lib/hermes-agent/venv/bin/hermes -p scout tools enable web --platform api_server") {
		t.Fatalf("profile command %v", fake.Commands())
	}

	status, out = call(t, httpSrv, "DELETE", "/profiles/scout", "")
	if status != http.StatusNoContent {
		t.Fatalf("delete %d %v", status, out)
	}
}

func TestProfileModelWriteIsReadBackFromProfiles(t *testing.T) {
	replies := map[string]string{
		"profile-model-set": `{"profile":"scout","provider":"anthropic","model":"claude-sonnet-4"}`,
		"profiles":          `{"multiplex":true,"profiles":[{"name":"scout","displayName":"Scout","model":{"default":"claude-sonnet-4","provider":"anthropic"}}]}`,
	}
	recorder, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	status, out := call(t, srv, "POST", "/profiles/scout/model", `{"provider":"anthropic","model":"claude-sonnet-4"}`)
	if status != http.StatusOK || out["profile"] != "scout" || out["provider"] != "anthropic" || out["model"] != "claude-sonnet-4" {
		t.Fatalf("%d %v", status, out)
	}
	if len(recorder.seen) < 1 || recorder.seen[0] != "profile-model-set" || !strings.Contains(recorder.bodies[0], `"name":"scout"`) || !strings.Contains(recorder.bodies[0], `"provider":"anthropic"`) {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
}

func TestProfileModelWriteRefusals(t *testing.T) {
	replies := map[string]string{
		"profile-model-set": `{"error":{"code":"PROFILE_NOT_FOUND","message":"missing"}}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	if status, out := call(t, srv, "POST", "/profiles/default/model", `{"provider":"anthropic","model":"claude-sonnet-4"}`); status != 400 || errorCode(out) != "PROFILE_INVALID" {
		t.Fatalf("default %d %v", status, out)
	}
	if status, out := call(t, srv, "POST", "/profiles/scout/model", `{"provider":"bad provider","model":"claude-sonnet-4"}`); status != 400 || errorCode(out) != "BODY_INVALID" {
		t.Fatalf("provider %d %v", status, out)
	}
	if status, out := call(t, srv, "POST", "/profiles/scout/model", `{"provider":"anthropic"}`); status != 400 || errorCode(out) != "BODY_INVALID" {
		t.Fatalf("missing model %d %v", status, out)
	}
	if status, out := call(t, srv, "POST", "/profiles/scout/model", `{"provider":"anthropic","model":"claude-sonnet-4"}`); status != 404 || errorCode(out) != "PROFILE_NOT_FOUND" {
		t.Fatalf("missing profile %d %v", status, out)
	}
}

func TestProfileCreateForwardsOptionalModel(t *testing.T) {
	replies := map[string]string{
		"profile-create": `{"profile":{"name":"scout"}}`,
		"profiles":       `{"multiplex":true,"profiles":[{"name":"scout","displayName":"Scout","model":{"default":"claude-sonnet-4","provider":"anthropic"}}]}`,
	}
	recorder := &probeRecorder{replies: replies}
	s := &Server{Probe: recorder.probe(), GatewayToken: func() (string, error) { return "root-bearer", nil }}
	httpSrv := httptest.NewServer(s.Handler())
	defer httpSrv.Close()
	status, out := call(t, httpSrv, "POST", "/profiles", `{"name":"scout","provider":"anthropic","model":"claude-sonnet-4"}`)
	if status != http.StatusCreated {
		t.Fatalf("%d %v", status, out)
	}
	profile, _ := out["profile"].(map[string]any)
	model, _ := profile["model"].(map[string]any)
	if model["provider"] != "anthropic" || model["default"] != "claude-sonnet-4" {
		t.Fatalf("profile %v", out)
	}
	if !strings.Contains(recorder.bodies[0], `"provider":"anthropic"`) || !strings.Contains(recorder.bodies[0], `"model":"claude-sonnet-4"`) {
		t.Fatalf("probe bodies %v", recorder.bodies)
	}
}

func TestProfileMCPCapabilityWriteIsReadBackFromProfiles(t *testing.T) {
	replies := map[string]string{
		"profile-mcp-set": `{"name":"linear","profile":"scout","enabled":false}`,
		"profiles":        `{"multiplex":true,"profiles":[{"name":"scout","mcpServers":[{"name":"linear","enabled":false}]}]}`,
	}
	recorder := &probeRecorder{replies: replies}
	marker := filepath.Join(t.TempDir(), "restart-pending")
	s := &Server{Probe: recorder.probe(), RestartMarker: marker}
	httpSrv := httptest.NewServer(s.Handler())
	defer httpSrv.Close()
	status, out := call(t, httpSrv, "POST", "/profiles/scout/mcp/servers/linear", `{"enabled":false}`)
	if status != http.StatusOK || out["profile"] != "scout" || out["enabled"] != false || out["applied"] != true {
		t.Fatalf("%d %v", status, out)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("MCP write did not set restart marker: %v", err)
	}
}

func TestProfileSkillWriteIsReadBackFromProfiles(t *testing.T) {
	replies := map[string]string{
		"profile-skill-set": `{"name":"research","profile":"scout","enabled":false}`,
		"profiles":          `{"multiplex":true,"profiles":[{"name":"scout","skills":[{"name":"research","enabled":false}]}]}`,
	}
	recorder := &probeRecorder{replies: replies}
	s := &Server{Probe: recorder.probe()}
	httpSrv := httptest.NewServer(s.Handler())
	defer httpSrv.Close()
	status, out := call(t, httpSrv, "POST", "/profiles/scout/skills/research", `{"enabled":false}`)
	if status != http.StatusOK || out["name"] != "research" || out["profile"] != "scout" || out["enabled"] != false || out["applied"] != true {
		t.Fatalf("%d %v", status, out)
	}
	if len(recorder.seen) < 1 || recorder.seen[0] != "profile-skill-set" || !strings.Contains(recorder.bodies[0], `"skill":"research"`) {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
}

func TestProfileBundledSkillsWriteReportsProbeProof(t *testing.T) {
	replies := map[string]string{
		"profile-bundled-skills-set": `{"profile":"scout","enabled":false,"bundled":4,"bundledEnabled":1,"essential":1}`,
	}
	recorder := &probeRecorder{replies: replies}
	s := &Server{Probe: recorder.probe()}
	status, out := callHandler(t, s.Handler(), "POST", "/profiles/scout/bundled-skills", `{"enabled":false}`)
	if status != http.StatusOK || out["profile"] != "scout" || out["requested"] != false || out["bundled"] != float64(4) || out["bundledEnabled"] != float64(1) || out["applied"] != true {
		t.Fatalf("%d %v", status, out)
	}
	if len(recorder.seen) != 1 || recorder.seen[0] != "profile-bundled-skills-set" || !strings.Contains(recorder.bodies[0], `"name":"scout"`) {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
}

func TestProfileBundledSkillsRejectsDefaultAndUnknownFields(t *testing.T) {
	recorder := &probeRecorder{replies: map[string]string{}}
	s := &Server{Probe: recorder.probe()}
	status, out := callHandler(t, s.Handler(), "POST", "/profiles/default/bundled-skills", `{"enabled":true}`)
	if status != http.StatusBadRequest || errorCode(out) != "PROFILE_INVALID" {
		t.Fatalf("default profile: %d %v", status, out)
	}
	status, out = callHandler(t, s.Handler(), "POST", "/profiles/scout/bundled-skills", `{"enabled":true,"skills":["research"]}`)
	if status != http.StatusBadRequest || errorCode(out) != "BODY_INVALID" {
		t.Fatalf("unknown field: %d %v", status, out)
	}
}

func callHandler(t *testing.T, handler http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("response JSON: %v", err)
	}
	return rec.Code, out
}

func TestProfileSkillRefusesUnknownSkill(t *testing.T) {
	_, _, srv := inventoryServer(t, map[string]string{
		"profile-skill-set": `{"error":{"code":"SKILL_NOT_FOUND","message":"missing"}}`,
	}, `{"data":[]}`)
	status, out := call(t, srv, "POST", "/profiles/scout/skills/missing", `{"enabled":true}`)
	if status != http.StatusNotFound || errorCode(out) != "SKILL_NOT_FOUND" {
		t.Fatalf("%d %v", status, out)
	}
}

func TestProfileSkillRejectsInvalidName(t *testing.T) {
	_, _, srv := inventoryServer(t, nil, `{"data":[]}`)
	status, out := call(t, srv, "POST", "/profiles/scout/skills/Bad_Name", `{"enabled":true}`)
	if status != http.StatusBadRequest || errorCode(out) != "SKILL_INVALID" {
		t.Fatalf("%d %v", status, out)
	}
}

func TestProfileCredentialAddIsProvenOnTheProfileCatalogue(t *testing.T) {
	replies := map[string]string{
		"profile-credential-set": `{"provider":"anthropic","profile":"scout"}`,
	}
	recorder := &probeRecorder{replies: replies}
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{ExitCode: 1, Stderr: "no -p auth"})
	s := &Server{
		Runner: fake,
		Probe:  recorder.probe(),
		ProfileCatalogue: func(_ context.Context, profile string) ([]byte, error) {
			if profile != "scout" {
				t.Fatalf("catalogue profile %q", profile)
			}
			return []byte(catalogueOK), nil
		},
	}
	httpSrv := httptest.NewServer(s.Handler())
	defer httpSrv.Close()
	status, out := call(t, httpSrv, "POST", "/profiles/scout/providers/anthropic/credentials", `{"apiKey":"sk-test-never-logged"}`)
	if status != http.StatusOK || out["provider"] != "anthropic" || out["profile"] != "scout" || out["verification"] != "confirmed" {
		t.Fatalf("%d %v", status, out)
	}
	if len(recorder.seen) != 1 || recorder.seen[0] != "profile-credential-set" {
		t.Fatalf("probe %v", recorder.seen)
	}
	if strings.Contains(strings.Join(fake.Commands(), " "), "sk-test-never-logged") {
		t.Fatal("api key appeared in argv")
	}
	encoded, _ := json.Marshal(out)
	if strings.Contains(string(encoded), "sk-test") {
		t.Fatal("api key appeared in the response")
	}
}

func TestProfileCredentialDeleteIsProvenOnTheProfileCatalogue(t *testing.T) {
	replies := map[string]string{
		"profile-credential-delete": `{"provider":"anthropic","profile":"scout"}`,
	}
	s := &Server{
		Probe: (&probeRecorder{replies: replies}).probe(),
		ProfileCatalogue: func(context.Context, string) ([]byte, error) {
			return []byte(`{"providers":[{"slug":"anthropic","authenticated":false}]}`), nil
		},
	}
	httpSrv := httptest.NewServer(s.Handler())
	defer httpSrv.Close()
	status, out := call(t, httpSrv, "DELETE", "/profiles/scout/providers/anthropic/credentials", "")
	if status != http.StatusOK || out["verification"] != "denied" || out["profile"] != "scout" {
		t.Fatalf("%d %v", status, out)
	}
}

func TestProfileMCPMapsUnknownRootServer(t *testing.T) {
	recorder, _, srv := inventoryServer(t, map[string]string{
		"profile-mcp-set": `{"error":{"code":"MCP_SERVER_NOT_FOUND","message":"missing"}}`,
	}, `{"data":[]}`)
	status, out := call(t, srv, "POST", "/profiles/scout/mcp/servers/missing", `{"enabled":true}`)
	if status != http.StatusNotFound || errorCode(out) != "MCP_SERVER_NOT_FOUND" || len(recorder.bodies) != 1 {
		t.Fatalf("%d %v %v", status, out, recorder.bodies)
	}
}

func TestHostProbeExercisesProfileVerbThroughStdinAndClosedArgv(t *testing.T) {
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{Stdout: `{"profile":{"name":"scout"}}`})
	probe := HostProbe(fake)
	out, err := probe(context.Background(), "profile-create", []byte(`{"name":"scout","apiServerKey":"local-bearer"}`))
	if err != nil || string(out) != `{"profile":{"name":"scout"}}` {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if len(fake.Calls) != 1 || !strings.HasSuffix(fake.Calls[0].String(), "inventory-probe.py profile-create") || strings.Contains(fake.Calls[0].String(), "local-bearer") || string(fake.Calls[0].Stdin) != `{"name":"scout","apiServerKey":"local-bearer"}` {
		t.Fatalf("probe call %+v", fake.Calls)
	}
	if _, err := probe(context.Background(), "not-a-verb", []byte(`{}`)); err == nil {
		t.Fatal("unknown probe verb was accepted")
	}
}

func TestToolsetToggleIsProvenOnTheGatewayNotOnTheCLI(t *testing.T) {
	replies := map[string]string{"toolsets": settableWebBrowser}
	_, fake, srv := inventoryServer(t, replies, `{"data":[{"name":"browser","enabled":true}]}`)
	status, out := call(t, srv, "POST", "/toolsets/browser", `{"enabled":true}`)
	if status != 200 || out["enabled"] != true || out["applied"] != true || out["platform"] != "api_server" {
		t.Fatalf("%d %v", status, out)
	}
	// The write targets api_server and nothing else: the Dashboard's own
	// default (`cli`) is invisible to the gateway every openedbot run uses.
	if len(fake.Calls) != 1 || !strings.Contains(fake.Calls[0].String(), "hermes tools enable browser --platform api_server") {
		t.Fatalf("argv %v", fake.Commands())
	}
}

func TestToolsetToggleReportsACLIThatLied(t *testing.T) {
	// `hermes tools` prints its refusals and still exits 0. The inventory
	// says the toolset stayed off, and THAT is what the link is told.
	replies := map[string]string{"toolsets": settableWebBrowser}
	_, _, srv := inventoryServer(t, replies, `{"data":[{"name":"browser","enabled":false}]}`)
	status, out := call(t, srv, "POST", "/toolsets/browser", `{"enabled":true}`)
	if status != 200 || out["enabled"] != false || out["applied"] != false || out["requested"] != true {
		t.Fatalf("%d %v", status, out)
	}
}

func TestToolsetToggleRefusals(t *testing.T) {
	replies := map[string]string{"toolsets": settableWebBrowser}
	_, fake, srv := inventoryServer(t, replies, `{"data":[]}`)

	// A forbidden toolset is refused before any host write: enabling it
	// through the link would leave `doctor` failing on this host.
	status, out := call(t, srv, "POST", "/toolsets/memory", `{"enabled":true}`)
	if status != 403 || errorCode(out) != "TOOLSET_FORBIDDEN" {
		t.Fatalf("%d %v", status, out)
	}
	// Disabling one is always allowed: that direction only ever restores
	// the contract.
	if status, _ := call(t, srv, "POST", "/toolsets/memory", `{"enabled":false}`); status == 403 {
		t.Fatal("disabling a forbidden toolset must never be refused")
	}
	// A toolset this platform cannot carry is named, not silently no-opped.
	status, out = call(t, srv, "POST", "/toolsets/discord", `{"enabled":true}`)
	if status != 404 || errorCode(out) != "TOOLSET_NOT_SETTABLE" {
		t.Fatalf("%d %v", status, out)
	}
	status, out = call(t, srv, "POST", "/toolsets/Not-A-Key", `{"enabled":true}`)
	if status != 400 || errorCode(out) != "TOOLSET_INVALID" {
		t.Fatalf("%d %v", status, out)
	}
	status, out = call(t, srv, "POST", "/toolsets/web", `{}`)
	if status != 400 || errorCode(out) != "BODY_INVALID" {
		t.Fatalf("%d %v", status, out)
	}
	for _, c := range fake.Calls {
		if strings.Contains(c.String(), "memory") || strings.Contains(c.String(), "discord") {
			t.Fatalf("a refused toolset reached the CLI: %s", c)
		}
	}
}

func TestProfileToolsetAllowsMemoryAndRefusesCronjob(t *testing.T) {
	replies := map[string]string{
		"toolsets":           `{"platform":"api_server","settable":["memory","session_search","cronjob","web"]}`,
		"profile-memory-set": `{"profile":"scout","memoryEnabled":true,"userProfileEnabled":true}`,
	}
	recorder, fake, srv := inventoryServer(t, replies, `{"data":[{"name":"memory","enabled":true}]}`)

	status, out := call(t, srv, "POST", "/profiles/scout/toolsets/memory", `{"enabled":true}`)
	if status != 200 || out["enabled"] != true || out["profile"] != "scout" {
		t.Fatalf("profile memory %d %v", status, out)
	}
	if len(fake.Calls) != 1 || !strings.Contains(fake.Calls[0].String(), "hermes -p scout tools enable memory --platform api_server") {
		t.Fatalf("argv %v", fake.Commands())
	}
	// The toolset entry alone never reaches a run: the profile's memory flags
	// must follow the toggle, on the profile, in the same request.
	memorySet := -1
	for index, verb := range recorder.seen {
		if verb == "profile-memory-set" {
			memorySet = index
		}
	}
	if memorySet < 0 || !strings.Contains(recorder.bodies[memorySet], `"name":"scout"`) || !strings.Contains(recorder.bodies[memorySet], `"enabled":true`) {
		t.Fatalf("memory flags probe %v %v", recorder.seen, recorder.bodies)
	}

	status, out = call(t, srv, "POST", "/profiles/scout/toolsets/cronjob", `{"enabled":true}`)
	if status != 403 || errorCode(out) != "TOOLSET_FORBIDDEN" {
		t.Fatalf("profile cronjob %d %v", status, out)
	}

	status, out = call(t, srv, "POST", "/toolsets/memory", `{"enabled":true}`)
	if status != 403 || errorCode(out) != "TOOLSET_FORBIDDEN" {
		t.Fatalf("root memory %d %v", status, out)
	}

	status, out = call(t, srv, "POST", "/profiles/scout/toolsets/delegation", `{"enabled":true}`)
	if status != 403 || errorCode(out) != "TOOLSET_FORBIDDEN" {
		t.Fatalf("profile delegation %d %v", status, out)
	}
}

func TestToolsetToggleUnverifiedWhenTheInventoryIsUnreadable(t *testing.T) {
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{})
	recorder := &probeRecorder{replies: map[string]string{"toolsets": settableWebBrowser}}
	s := &Server{Runner: fake, Probe: recorder.probe(), Inventory: func(context.Context) ([]byte, error) {
		return []byte(`not json`), nil
	}}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	status, out := call(t, srv, "POST", "/toolsets/web", `{"enabled":true}`)
	if status != 502 || errorCode(out) != "TOOLSET_UNVERIFIED" {
		t.Fatalf("%d %v", status, out)
	}
}

func TestMCPInventoryNeverCarriesASecret(t *testing.T) {
	reply := `{"platform":"api_server","servers":[{"name":"linear","transport":"http","endpoint":"https://mcp.linear.app/mcp","auth":"header","configEnabled":true,"platformEnabled":true,"envKeys":["MCP_LINEAR_API_KEY"]}],"catalog":[{"name":"n8n","authType":"api_key","transport":"stdio","requiresInstall":true,"envSpecs":[{"name":"N8N_API_KEY","required":true,"secret":true}]}]}`
	_, _, srv := inventoryServer(t, map[string]string{"mcp-inventory": reply}, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/mcp/servers", "")
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	encoded, _ := json.Marshal(out)
	// The env is reported by KEY only: an MCP entry's env VALUE is routinely
	// a token, and a settings page has no use for it.
	if !strings.Contains(string(encoded), "MCP_LINEAR_API_KEY") || strings.Contains(string(encoded), "Authorization") {
		t.Fatalf("%s", encoded)
	}
}

func TestMCPAddRefusesAStdioCommandAndKeepsTheTokenOffArgv(t *testing.T) {
	reply := `{"server":{"name":"linear","transport":"http","endpoint":"https://mcp.linear.app/mcp","auth":"header","configEnabled":true,"platformEnabled":true,"envKeys":["MCP_LINEAR_API_KEY"],"discoveredTools":["create_issue"]}}`
	recorder, _, srv := inventoryServer(t, map[string]string{"mcp-add": reply}, `{"data":[]}`)

	// A stdio server means naming an executable and its argv. The link
	// carries no command toward the host, and says so rather than quietly
	// creating something else.
	status, out := call(t, srv, "POST", "/mcp/servers", `{"name":"x","command":"npx"}`)
	if status != 400 || errorCode(out) != "STDIO_REFUSED" {
		t.Fatalf("%d %v", status, out)
	}

	status, out = call(t, srv, "POST", "/mcp/servers", `{"name":"linear","url":"https://mcp.linear.app/mcp","auth":"header","token":"lin_secret"}`)
	if status != 200 || out["name"] != "linear" {
		t.Fatalf("%d %v", status, out)
	}
	// The token reaches the program on stdin and never comes back out.
	if len(recorder.bodies) != 1 || !strings.Contains(recorder.bodies[0], "lin_secret") {
		t.Fatalf("request %v", recorder.bodies)
	}
	encoded, _ := json.Marshal(out)
	if strings.Contains(string(encoded), "lin_secret") {
		t.Fatalf("the token came back in the response: %s", encoded)
	}
}

func TestMCPRefusalsKeepTheirCode(t *testing.T) {
	replies := map[string]string{
		"mcp-add":     `{"error":{"code":"SERVER_EXISTS","message":"already there"}}`,
		"mcp-install": `{"error":{"code":"CATALOG_ENTRY_UNKNOWN","message":"unknown"}}`,
		"mcp-remove":  `{"error":{"code":"SERVER_UNKNOWN","message":"gone"}}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	for _, tc := range []struct {
		method, path, body, code string
		status                   int
	}{
		{"POST", "/mcp/servers", `{"name":"x","url":"https://x/mcp"}`, "SERVER_EXISTS", 409},
		{"POST", "/mcp/catalog/nope", `{}`, "CATALOG_ENTRY_UNKNOWN", 404},
		{"DELETE", "/mcp/servers/gone", "", "SERVER_UNKNOWN", 404},
	} {
		status, out := call(t, srv, tc.method, tc.path, tc.body)
		if status != tc.status || errorCode(out) != tc.code {
			t.Fatalf("%s %s: %d %v", tc.method, tc.path, status, out)
		}
	}
	// A failure that is not part of the contract never leaks upstream text.
	_, _, broken := inventoryServer(t, map[string]string{"mcp-inventory": `{"error":{"code":"HOST_FAILED","message":"Traceback: /srv/hermes/data/config.yaml"}}`}, `{"data":[]}`)
	status, out := call(t, broken, "GET", "/mcp/servers", "")
	if status != 502 || errorCode(out) != "HOST_UNAVAILABLE" {
		t.Fatalf("%d %v", status, out)
	}
	if strings.Contains(errorMessage(out), "Traceback") {
		t.Fatalf("upstream diagnostics reached the link: %v", out)
	}
}

func TestUnknownRouteStaysUnknown(t *testing.T) {
	_, _, srv := inventoryServer(t, nil, `{"data":[]}`)
	if status, _ := call(t, srv, "POST", "/mcp/servers/linear", `{}`); status != 404 {
		t.Fatalf("status %d", status)
	}
}

const scoutInventory = `{"profiles":[{"name":"scout","displayName":"Scout","title":"Scout","description":"Find sources.","soul":"# Scout\nA researcher.","model":{"default":"claude-sonnet-4","provider":"anthropic"},"uiMeta":{"title":"Scout","color":"#3b93f0","shape":"circle","imageKind":"generated","hidden":false,"pinned":true,"sectionId":null,"groups":["newsroom"],"created":"2026-09-01T00:00:00Z"},"hasAvatar":true,"routines":[{"name":"Morning brief","schedule":"30 8 * * 1,2,3,4,5","prompt":"Prepare the brief.","enabled":true,"deliver":true,"model":null}],"skills":[{"name":"research","enabled":true}],"toolsets":[{"name":"web","enabled":true}],"mcpServers":[{"name":"linear","enabled":false}]}]}`

func TestProfileInventoryIsANamedRead(t *testing.T) {
	recorder, _, srv := inventoryServer(t, map[string]string{"profiles": scoutInventory}, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/profiles", "")
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	profiles, _ := out["profiles"].([]any)
	if len(profiles) != 1 {
		t.Fatalf("profiles %v", out)
	}
	row, _ := profiles[0].(map[string]any)
	if row["name"] != "scout" || row["hasAvatar"] != true {
		t.Fatalf("%v", row)
	}
	if _, ok := row["env"]; ok {
		t.Fatal("an .env must never cross")
	}
	if recorder.seen[0] != "profiles" || recorder.bodies[0] != "{}" {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
}

func TestProfileAvatarIsABoundedImage(t *testing.T) {
	// 1x1 PNG, well under the bound.
	png := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	replies := map[string]string{
		"profile-avatar": `{"name":"scout","contentType":"image/png","bytes":"` + png + `"}`,
	}
	recorder, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	req, _ := http.NewRequest("GET", srv.URL+"/profiles/scout/avatar", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := make([]byte, 64)
	n, _ := resp.Body.Read(body)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" || n < 8 {
		t.Fatalf("%d %s %d", resp.StatusCode, resp.Header.Get("Content-Type"), n)
	}
	if recorder.seen[0] != "profile-avatar" || !strings.Contains(recorder.bodies[0], `"name":"scout"`) {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
}

func TestProfileAvatarRefusals(t *testing.T) {
	replies := map[string]string{
		"profile-avatar": `{"error":{"code":"AVATAR_NOT_FOUND","message":"this profile has no avatar"}}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	if status, out := call(t, srv, "GET", "/profiles/scout/avatar", ""); status != 404 || errorCode(out) != "AVATAR_NOT_FOUND" {
		t.Fatalf("%d %v", status, out)
	}
	if status, out := call(t, srv, "GET", "/profiles/Default/avatar", ""); status != 400 || errorCode(out) != "PROFILE_INVALID" {
		t.Fatalf("uppercase slug %d %v", status, out)
	}
	if status, out := call(t, srv, "GET", "/profiles/default/avatar", ""); status != 400 || errorCode(out) != "PROFILE_INVALID" {
		t.Fatalf("default %d %v", status, out)
	}
}

func errorCode(out map[string]any) string {
	detail, _ := out["error"].(map[string]any)
	code, _ := detail["code"].(string)
	return code
}

func errorMessage(out map[string]any) string {
	detail, _ := out["error"].(map[string]any)
	message, _ := detail["message"].(string)
	return message
}

func containsString(raw any, want string) bool {
	values, _ := raw.([]any)
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// countingProbe records how many times each verb actually reached the host,
// and how long each call took, so the cache is proven by cost and not by hope.
type countingProbe struct {
	mu      sync.Mutex
	calls   map[string]int
	replies map[string]string
	delay   time.Duration
}

func (p *countingProbe) probe() Probe {
	return func(ctx context.Context, verb string, _ []byte) ([]byte, error) {
		p.mu.Lock()
		if p.calls == nil {
			p.calls = map[string]int{}
		}
		p.calls[verb]++
		reply := p.replies[verb]
		delay := p.delay
		p.mu.Unlock()
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if reply == "" {
			reply = `{"error":{"code":"HOST_FAILED","message":"no reply"}}`
		}
		return []byte(reply), nil
	}
}

func (p *countingProbe) count(verb string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[verb]
}

func cachedServer(t *testing.T, recorder *countingProbe, clock *time.Time) *httptest.Server {
	t.Helper()
	srv, _ := cachedServerAndOperator(t, recorder, clock)
	return srv
}

// cachedServerAndOperator is cachedServer that also hands back the Server, for
// tests that must wait for a read it refreshes in the background.
func cachedServerAndOperator(t *testing.T, recorder *countingProbe, clock *time.Time) (*httptest.Server, *Server) {
	t.Helper()
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{})
	s := &Server{
		Runner: fake,
		Probe:  recorder.probe(),
		Now:    func() time.Time { return *clock },
		Inventory: func(context.Context) ([]byte, error) {
			return []byte(`{"data":[{"name":"web","enabled":true}]}`), nil
		},
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv, s
}

// awaitBackgroundRead blocks until the read of verb the server has in flight,
// if any, has finished. readCached registers that flight under s.mu before it
// answers, so once the request that triggered it has returned, the flight is
// either still listed here or already done; waiting on its channel needs no
// sleep and no timeout.
func awaitBackgroundRead(s *Server, verb string) {
	s.mu.Lock()
	flight := s.probeFlights[verb]
	s.mu.Unlock()
	if flight != nil {
		<-flight.done
	}
}

func TestReadsAreCachedBecauseEachOneStartsAColdInterpreter(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	recorder := &countingProbe{replies: map[string]string{
		"toolsets":      settableWebBrowser,
		"mcp-inventory": `{"platform":"api_server","servers":[],"catalog":[]}`,
	}}
	srv, s := cachedServerAndOperator(t, recorder, &clock)

	for range 3 {
		if status, _ := call(t, srv, "GET", "/toolsets", ""); status != 200 {
			t.Fatalf("status %d", status)
		}
		if status, _ := call(t, srv, "GET", "/mcp/servers", ""); status != 200 {
			t.Fatalf("status %d", status)
		}
	}
	if recorder.count("toolsets") != 1 || recorder.count("mcp-inventory") != 1 {
		t.Fatalf("the host was asked more than once: %v", recorder.calls)
	}

	// Past the window, the host is asked again: the cache bounds the cost, it
	// does not freeze the answer.
	clock = clock.Add(ReadCacheTTL + time.Second)
	call(t, srv, "GET", "/toolsets", "")
	// Within StaleReadLimit the expired document is answered at once and the
	// host is asked again in the background (stale-while-revalidate): wait for
	// that read instead of racing it.
	awaitBackgroundRead(s, "toolsets")
	if recorder.count("toolsets") != 2 {
		t.Fatalf("an expired document must be refetched: %v", recorder.calls)
	}
}

func TestAWriteDropsTheCachedReads(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	recorder := &countingProbe{replies: map[string]string{
		"toolsets":      settableWebBrowser,
		"mcp-inventory": `{"platform":"api_server","servers":[],"catalog":[]}`,
		"mcp-remove":    `{"removed":"linear","tokensRemoved":true}`,
	}}
	srv := cachedServer(t, recorder, &clock)

	call(t, srv, "GET", "/mcp/servers", "")
	call(t, srv, "GET", "/toolsets", "")
	if status, _ := call(t, srv, "DELETE", "/mcp/servers/linear", ""); status != 200 {
		t.Fatalf("status %d", status)
	}
	// Both reads are dropped, not only the MCP one: removing a server also
	// changes what the api_server platform carries.
	call(t, srv, "GET", "/mcp/servers", "")
	call(t, srv, "GET", "/toolsets", "")
	if recorder.count("mcp-inventory") != 2 || recorder.count("toolsets") != 2 {
		t.Fatalf("a write must invalidate every cached read: %v", recorder.calls)
	}
	// A toolset write does the same, even though it runs the CLI and never
	// touches the probe: `platform_toolsets.api_server` is precisely what
	// decides the `platformEnabled` flag of every MCP server listed above.
	call(t, srv, "POST", "/toolsets/web", `{"enabled":true}`)
	call(t, srv, "GET", "/mcp/servers", "")
	if recorder.count("mcp-inventory") != 3 {
		t.Fatalf("a toolset write must invalidate the MCP inventory: %v", recorder.calls)
	}
}

func TestConcurrentReadsShareOneInterpreterStart(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	recorder := &countingProbe{
		replies: map[string]string{"mcp-inventory": `{"platform":"api_server","servers":[],"catalog":[]}`},
		delay:   80 * time.Millisecond,
	}
	srv := cachedServer(t, recorder, &clock)

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := http.Get(srv.URL + "/mcp/servers")
			if err != nil {
				return
			}
			resp.Body.Close()
		}()
	}
	wg.Wait()
	// Eight page loads on a one-vCPU host must not become eight Python starts.
	if recorder.count("mcp-inventory") != 1 {
		t.Fatalf("concurrent reads started %d interpreters", recorder.count("mcp-inventory"))
	}
}

func TestAReadThatRacedAWriteIsServedOnceAndNeverCached(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	recorder := &countingProbe{
		replies: map[string]string{
			"mcp-inventory": `{"platform":"api_server","servers":[],"catalog":[]}`,
			"mcp-remove":    `{"removed":"linear","tokensRemoved":true}`,
		},
		delay: 120 * time.Millisecond,
	}
	srv := cachedServer(t, recorder, &clock)

	// The read starts first and finishes last; the write lands in between. The
	// document it carries describes the state BEFORE the removal, so serving it
	// once is unavoidable. Pinning it for a whole TTL is not.
	done := make(chan struct{})
	go func() {
		defer close(done)
		resp, err := http.Get(srv.URL + "/mcp/servers")
		if err == nil {
			resp.Body.Close()
		}
	}()
	time.Sleep(20 * time.Millisecond)
	if status, _ := call(t, srv, "DELETE", "/mcp/servers/linear", ""); status != 200 {
		t.Fatal("the write must not wait for the read")
	}
	<-done

	call(t, srv, "GET", "/mcp/servers", "")
	if recorder.count("mcp-inventory") != 2 {
		t.Fatalf("a read that raced a write must not be cached: %v", recorder.calls)
	}
}

// A verb the Python program knows but the Go allowlist refuses fails on the
// host with a generic HOST_UNAVAILABLE (profile-memory-set, 2026-09-07). The
// two lists are one contract: every VERBS entry of the program is allowed.
func TestProbeVerbAllowlistMatchesTheProgram(t *testing.T) {
	script := string(inventoryProbeScript)
	start := strings.Index(script, "VERBS = {")
	end := strings.Index(script[start:], "}")
	if start < 0 || end < 0 {
		t.Fatalf("VERBS block not found in the probe program")
	}
	block := script[start : start+end]
	var declared []string
	for _, line := range strings.Split(block, "\n") {
		line = strings.Trim(strings.TrimSpace(line), `",`)
		if line != "" && !strings.HasPrefix(line, "VERBS") {
			declared = append(declared, line)
		}
	}
	if len(declared) == 0 {
		t.Fatalf("no verb declared in the probe program")
	}
	for _, verb := range declared {
		if !probeVerbs[verb] {
			t.Fatalf("verb %q is declared by the program but refused by probeVerbs", verb)
		}
	}
	for verb := range probeVerbs {
		if !slices.Contains(declared, verb) {
			t.Fatalf("verb %q is allowed by probeVerbs but unknown to the program", verb)
		}
	}
}

func TestProfileMemoryReadAndWriteGoThroughTheProgram(t *testing.T) {
	view := `{"profile":"scout","memoryEnabled":true,"userProfileEnabled":true,"limits":{"memory":2200,"user":1375},"entries":{"memory":["Le projet est un monorepo Bun."],"user":[]},"usedChars":{"memory":30,"user":0}}`
	replies := map[string]string{
		"profile-memory-get":   view,
		"profile-memory-write": view,
	}
	recorder, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/profiles/scout/memory", "")
	if status != 200 || out["profile"] != "scout" {
		t.Fatalf("read %d %v", status, out)
	}
	status, out = call(t, srv, "POST", "/profiles/scout/memory", `{"target":"user","action":"add","content":"Elodie, CTO, Paris."}`)
	if status != 200 || out["profile"] != "scout" {
		t.Fatalf("write %d %v", status, out)
	}
	if len(recorder.seen) != 2 || recorder.seen[1] != "profile-memory-write" ||
		!strings.Contains(recorder.bodies[1], `"target":"user"`) || !strings.Contains(recorder.bodies[1], `"action":"add"`) {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
	// The wire grammar is checked before the program runs: a foreign target or
	// verb, `default`, an oversized entry never reach it.
	if status, out := call(t, srv, "POST", "/profiles/scout/memory", `{"target":"soul","action":"add","content":"x"}`); status != 400 || errorCode(out) != "MEMORY_INVALID" {
		t.Fatalf("target %d %v", status, out)
	}
	if status, out := call(t, srv, "POST", "/profiles/scout/memory", `{"target":"memory","action":"purge","content":"x"}`); status != 400 || errorCode(out) != "MEMORY_INVALID" {
		t.Fatalf("action %d %v", status, out)
	}
	if status, out := call(t, srv, "GET", "/profiles/default/memory", ""); status != 400 || errorCode(out) != "PROFILE_INVALID" {
		t.Fatalf("default %d %v", status, out)
	}
	if len(recorder.seen) != 2 {
		t.Fatalf("a refused write reached the program: %v", recorder.seen)
	}
}

func TestProfileMemoryRefusalsCrossWithTheirCode(t *testing.T) {
	replies := map[string]string{
		"profile-memory-write": `{"error":{"code":"MEMORY_REFUSED","message":"Memory at 2,200/2,200 chars. Adding this entry would exceed the limit."}}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	status, out := call(t, srv, "POST", "/profiles/scout/memory", `{"target":"memory","action":"add","content":"x"}`)
	if status != 409 || errorCode(out) != "MEMORY_REFUSED" {
		t.Fatalf("%d %v", status, out)
	}
}

// Upstream turns `x_search` back on under an empty platform list when xAI
// credentials exist (lab, 2026-10-24): the CLI disable reads back enabled.
// The host then suppresses it in the profile's `agent.disabled_toolsets` and
// proves the change on a second read; a toolset that moved needs no suppression.
func TestProfileToolsetDisableFallsBackToSuppression(t *testing.T) {
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{})
	suppressed := false
	var verbs, bodies []string
	s := &Server{
		Runner: fake,
		Probe: func(_ context.Context, verb string, request []byte) ([]byte, error) {
			verbs = append(verbs, verb)
			bodies = append(bodies, string(request))
			switch verb {
			case "toolsets":
				return []byte(`{"platform":"api_server","settable":["x_search","web"]}`), nil
			case "profile-toolset-suppress":
				suppressed = true
				return []byte(`{"profile":"ohb-reviewer","toolset":"x_search","suppressed":true}`), nil
			}
			return []byte(`{"error":{"code":"HOST_FAILED","message":"no reply"}}`), nil
		},
		Inventory: func(context.Context) ([]byte, error) { return []byte(`{"data":[]}`), nil },
		ProfileInventory: func(context.Context, string) ([]byte, error) {
			return []byte(`{"data":[{"name":"x_search","enabled":` + map[bool]string{true: "false", false: "true"}[suppressed] + `},{"name":"web","enabled":false}]}`), nil
		},
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)

	status, out := call(t, srv, "POST", "/profiles/ohb-reviewer/toolsets/x_search", `{"enabled":false}`)
	if status != 200 || out["enabled"] != false || out["applied"] != true {
		t.Fatalf("suppressed disable %d %v", status, out)
	}
	if !slices.Contains(verbs, "profile-toolset-suppress") || !strings.Contains(bodies[len(bodies)-1], `"suppressed":true`) {
		t.Fatalf("suppression probe %v %v", verbs, bodies)
	}

	verbs = nil
	status, out = call(t, srv, "POST", "/profiles/ohb-reviewer/toolsets/web", `{"enabled":false}`)
	if status != 200 || out["applied"] != true || slices.Contains(verbs, "profile-toolset-suppress") {
		t.Fatalf("plain disable %d %v %v", status, out, verbs)
	}
}
