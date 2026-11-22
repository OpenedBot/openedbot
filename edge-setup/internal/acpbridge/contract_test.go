package acpbridge

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
)

type contractVector struct {
	Name    string         `json:"name"`
	Kind    string         `json:"kind"`
	Payload map[string]any `json:"payload"`
}

// The exact lot-1 fixtures are compared byte-for-byte by contract-check. This
// assertion checks emitted wire payloads against their fixture's field types,
// plus the mandatory fields, identities and limits specified by that contract.
func assertContract(t *testing.T, kind string, payload any) {
	t.Helper()
	raw, err := os.ReadFile("../../test/golden/run-contract/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []contractVector
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	raw, err = json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]any
	if err = json.Unmarshal(raw, &actual); err != nil {
		t.Fatal(err)
	}
	var template map[string]any
	for _, v := range vectors {
		if v.Kind != kind {
			continue
		}
		if kind == "event" && v.Payload["event"] != actual["event"] {
			continue
		}
		if kind == "run-status" && v.Payload["status"] != actual["status"] {
			continue
		}
		template = v.Payload
		break
	}
	if template == nil {
		t.Fatalf("no fixture for %s %v", kind, actual)
	}
	var compare func(string, any, any)
	compare = func(path string, want, got any) {
		t.Helper()
		if want == nil {
			return
		}
		switch w := want.(type) {
		case map[string]any:
			g, ok := got.(map[string]any)
			if !ok {
				t.Fatalf("%s must be object", path)
			}
			for k, value := range g {
				if expected, ok := w[k]; ok {
					compare(path+"."+k, expected, value)
				}
			}
		case []any:
			g, ok := got.([]any)
			if !ok {
				t.Fatalf("%s must be array", path)
			}
			if len(w) > 0 {
				for _, value := range g {
					compare(path+"[]", w[0], value)
				}
			}
		default:
			if reflect.TypeOf(want) != reflect.TypeOf(got) {
				t.Fatalf("%s type %T expected %T", path, got, want)
			}
		}
	}
	compare(kind, template, actual)
	required := map[string][]string{"run-create": {"run_id"}, "session-created": {"id"}, "session-create": {"id", "title"}, "run-status": {"status"}, "approval": {"request_id", "execution_generation", "choice"}, "capabilities": {"features", "endpoints", "max_concurrent_runs"}, "toolsets": {"data"}, "model-options": {"providers"}}
	keys := required[kind]
	if kind == "event" {
		keys = []string{"event", "run_id", "timestamp"}
		extra := map[string][]string{"message.delta": {"delta"}, "tool.started": {"tool", "tool_call_id"}, "tool.completed": {"tool", "tool_call_id"}, "approval.request": {"request_id", "execution_generation", "command", "description", "choices"}, "approval.responded": {"choice"}, "run.completed": {"output"}}
		keys = append(keys, extra[actual["event"].(string)]...)
		ts, ok := actual["timestamp"].(float64)
		if !ok || math.IsNaN(ts) || math.IsInf(ts, 0) {
			t.Fatal("invalid timestamp")
		}
	}
	for _, key := range keys {
		if _, ok := actual[key]; !ok {
			t.Fatalf("missing %s in %s", key, raw)
		}
	}
	if kind == "event" && actual["event"] == "approval.request" {
		for _, c := range actual["choices"].([]any) {
			if c != "once" && c != "deny" && c != "always" {
				t.Fatalf("unapplyable approval scope %v", c)
			}
		}
	}
	if id, ok := actual["tool_call_id"].(string); ok && (len(id) == 0 || len(id) > 200) {
		t.Fatal("invalid tool identity")
	}
	if id, ok := actual["request_id"].(string); ok && (len(id) == 0 || len(id) > 256) {
		t.Fatal("invalid approval identity")
	}
	if kind == "approval" && len(actual) != 3 {
		t.Fatal("approval has extra fields")
	}
}
func TestBridgePayloadsMatchContractFixtures(t *testing.T) {
	f := newFixture(t, "plain")
	for path, kind := range map[string]string{"/v1/capabilities": "capabilities", "/v1/toolsets": "toolsets", "/api/model/options": "model-options"} {
		status, raw := f.request("GET", path, nil, "")
		if status != 200 {
			t.Fatal(status)
		}
		var payload any
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		assertContract(t, kind, payload)
	}
	sessionBody := map[string]string{"id": "cloud", "title": "contract"}
	assertContract(t, "session-create", sessionBody)
	status, raw := f.request("POST", "/api/sessions", sessionBody, "")
	if status != 201 {
		t.Fatal(status)
	}
	var created any
	_ = json.Unmarshal(raw, &created)
	assertContract(t, "session-created", created)
	for _, scenario := range []string{"plain", "tools", "permission", "refusal", "cancel", "crash"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, scenario)
			f.session("cloud")
			id := f.run(input("cloud"), "")
			assertContract(t, "run-create", map[string]string{"run_id": id})
			if scenario == "permission" {
				for i := 0; i < 2; i++ {
					var e Event
					for {
						f.b.mu.Lock()
						count := 0
						for _, candidate := range f.b.disk.Runs[id].Events {
							if candidate["event"] == "approval.request" {
								if count == i {
									e = candidate
								}
								count++
							}
						}
						wake := f.b.changed
						f.b.mu.Unlock()
						if e != nil {
							break
						}
						select {
						case <-wake:
						case <-f.t.Context().Done():
							t.Fatal("permission missing")
						}
					}
					body := map[string]any{"request_id": e["request_id"], "execution_generation": e["execution_generation"], "choice": "once"}
					assertContract(t, "approval", body)
					if status, _ := f.request("POST", "/v1/runs/"+id+"/approval", body, ""); status != 200 {
						t.Fatal(status)
					}
				}
			}
			if scenario == "cancel" {
				f.await(id, "approval.request")
				f.request("POST", "/v1/runs/"+id+"/stop", nil, "")
			}
			events := f.events(id)
			for _, e := range events {
				assertContract(t, "event", e)
				if e["run_id"] != id {
					t.Fatal("unstable run identity")
				}
				if e["event"] == "message.delta" && len(e["delta"].(string)) > 64*1024 {
					t.Fatal("oversize delta")
				}
			}
			_, raw := f.request("GET", "/v1/runs/"+id, nil, "")
			var status any
			_ = json.Unmarshal(raw, &status)
			assertContract(t, "run-status", status)
			frames := fmt.Sprint(events)
			if strings.Contains(frames, "usage:") {
				t.Fatal("fabricated per-turn usage")
			}
		})
	}
}
