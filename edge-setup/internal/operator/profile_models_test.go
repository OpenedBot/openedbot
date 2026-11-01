package operator

import (
	"encoding/json"
	"net/http"
	osexec "os/exec"
	"strings"
	"testing"
)

func TestProfileModelsBatchIsOneProbeAndOneReadBack(t *testing.T) {
	replies := map[string]string{
		"profile-models-set": `{"profiles":[{"profile":"scout"},{"profile":"ghost","code":"PROFILE_NOT_FOUND"},{"profile":"drift"}]}`,
		"profiles": `{"multiplex":true,"profiles":[` +
			`{"name":"scout","displayName":"Scout","model":{"default":"grok-4.7","provider":"xai-oauth"}},` +
			`{"name":"drift","displayName":"Drift","model":{"default":"gpt-6","provider":"openai-codex"}}]}`,
	}
	recorder, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	status, out := call(t, srv, "POST", "/profiles/models", `{"provider":"xai-oauth","model":"grok-4.7","profiles":["scout","ghost","drift","scout"]}`)
	if status != http.StatusOK {
		t.Fatalf("%d %v", status, out)
	}
	if strings.Join(recorder.seen, ",") != "profile-models-set,profiles" {
		t.Fatalf("one write probe then one inventory read, got %v", recorder.seen)
	}
	if !strings.Contains(recorder.bodies[0], `"names":["scout","ghost","drift"]`) {
		t.Fatalf("duplicates must be dropped before the probe: %v", recorder.bodies[0])
	}
	raw, _ := json.Marshal(out["profiles"])
	var results []profileModelResult
	if err := json.Unmarshal(raw, &results); err != nil || len(results) != 3 {
		t.Fatalf("results %s %v", raw, err)
	}
	// Applied is read on the inventory, never taken from the probe's word.
	if !results[0].Applied || results[1].Applied || results[1].Code != "PROFILE_NOT_FOUND" || results[2].Applied || results[2].Code != "" {
		t.Fatalf("results %+v", results)
	}
}

func TestProfileModelsBatchRefusals(t *testing.T) {
	_, _, srv := inventoryServer(t, map[string]string{}, `{"data":[]}`)
	tooMany := `"p0"` + strings.Repeat(`,"p0"`, MaxProfileModelBatch)
	for _, body := range []string{
		`{"provider":"xai-oauth","model":"grok-4.7","profiles":[]}`,
		`{"provider":"xai-oauth","model":"grok-4.7","profiles":[` + tooMany + `]}`,
		`{"provider":"bad provider","model":"grok-4.7","profiles":["scout"]}`,
	} {
		if status, out := call(t, srv, "POST", "/profiles/models", body); status != http.StatusBadRequest || errorCode(out) != "BODY_INVALID" {
			t.Fatalf("%s: %d %v", body, status, out)
		}
	}
	for _, name := range []string{"default", "../etc", "UPPER"} {
		body := `{"provider":"xai-oauth","model":"grok-4.7","profiles":["scout","` + name + `"]}`
		if status, out := call(t, srv, "POST", "/profiles/models", body); status != http.StatusBadRequest || errorCode(out) != "PROFILE_INVALID" {
			t.Fatalf("%s: %d %v", name, status, out)
		}
	}
}

func TestProfileModelsProbeWritesEachProfileAndReportsRefusals(t *testing.T) {
	code := `import json, sys
scope = {"__name__": "profile_models_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
configs = {"scout": {"model": {"default": "gpt-6", "provider": "openai-codex", "base_url": "kept"}}, "broken": {}}
saved = {}
scope["profile_exists"] = lambda name: name in configs
scope["load_profile_config"] = lambda name: dict(configs[name])
def save(name, config):
    if name == "broken":
        raise OSError("fixture-secret")
    saved[name] = config
scope["save_profile_config"] = save
result = scope["invoke_handler"]("profile-models-set", {"provider": "xai-oauth", "model": "grok-4.7", "names": ["scout", "ghost", "broken", "Bad"]})
print(json.dumps({"result": result, "saved": saved}))
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("probe: %v\n%s", err, output)
	}
	var got struct {
		Result struct {
			Profiles []struct{ Profile, Code string } `json:"profiles"`
		} `json:"result"`
		Saved map[string]map[string]map[string]string `json:"saved"`
	}
	if err := json.Unmarshal(output, &got); err != nil {
		t.Fatalf("%v\n%s", err, output)
	}
	codes := []string{}
	for _, entry := range got.Result.Profiles {
		codes = append(codes, entry.Profile+":"+entry.Code)
	}
	if strings.Join(codes, ",") != "scout:,ghost:PROFILE_NOT_FOUND,broken:PROFILE_CONFIG_REFUSED,Bad:PROFILE_INVALID" {
		t.Fatalf("codes %v", codes)
	}
	model := got.Saved["scout"]["model"]
	if model["provider"] != "xai-oauth" || model["default"] != "grok-4.7" || model["base_url"] != "kept" || len(got.Saved) != 1 {
		t.Fatalf("saved %v", got.Saved)
	}
	if strings.Contains(string(output), "fixture-secret") {
		t.Fatalf("an exception message crossed the probe: %s", output)
	}
}
