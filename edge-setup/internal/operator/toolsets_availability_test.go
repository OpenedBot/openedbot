package operator

import "testing"

func TestToolsetsRelayAvailabilityBounded(t *testing.T) {
	reply := `{"platform":"api_server","settable":["browser","web"],"availability":[` +
		`{"name":"browser","available":false,"reason":"check_failed"},` +
		`{"name":"web","available":true,"reason":"check_failed"},` +
		`{"name":"image_gen","available":false,"reason":"/opt/secret/path"},` +
		`{"name":"a2a","available":true,"reason":null},` +
		`{"name":"Bad Name","available":true,"reason":null},` +
		`{"name":"browser","available":true,"reason":null},` +
		`{"name":"vision","available":null,"reason":"check_failed"}]}`
	_, _, srv := inventoryServer(t, map[string]string{"toolsets": reply}, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/toolsets", "")
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	rows, _ := out["availability"].([]any)
	// a2a is dropped without the guard, a bad name and a duplicate are dropped,
	// a reason survives only on an unavailable toolset and only from the closed set.
	want := map[string][2]any{
		"browser":   {false, "check_failed"},
		"web":       {true, nil},
		"image_gen": {false, nil},
		"vision":    {nil, nil},
	}
	if len(rows) != len(want) {
		t.Fatalf("rows %v", rows)
	}
	for _, raw := range rows {
		row := raw.(map[string]any)
		expect, ok := want[row["name"].(string)]
		if !ok || row["available"] != expect[0] || row["reason"] != expect[1] {
			t.Fatalf("row %v", row)
		}
	}
}

func TestToolsetsFromAnOlderProbeCarryNoAvailability(t *testing.T) {
	_, _, srv := inventoryServer(t, map[string]string{"toolsets": settableWebBrowser}, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/toolsets", "")
	if _, present := out["availability"]; status != 200 || present {
		t.Fatalf("an absent field must stay absent: %d %v", status, out)
	}
}
