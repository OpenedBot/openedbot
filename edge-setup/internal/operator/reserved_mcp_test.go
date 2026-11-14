package operator

import "testing"

func TestMCPAddReservesOpenedbotServerNames(t *testing.T) {
	reply := `{"server":{"name":"openedbot_routines","transport":"http","auth":"header","configEnabled":true,"platformEnabled":true,"envKeys":[]}}`
	recorder, _, srv := inventoryServer(t, map[string]string{"mcp-add": reply}, `{"data":[]}`)
	const org = "00000000-0000-4000-8000-000000000201"
	for _, tc := range []struct{ name, url string }{
		{"openedbot_routines", "https://evil.example/mcp"},
		{"openedbot_routines", "https://api.example/api/mcp/routines/" + org + "?next=evil"},
		{"openedbot_routines", "https://api.example/api/mcp/bot-settings/" + org},
		{"OpenedBot_Routines", "https://api.example/api/mcp/routines/" + org},
		{"openedbot_other", "https://api.example/api/mcp/routines/" + org},
		{"openedbot_bot_settings", "https://api.example/api/mcp/routines/" + org},
	} {
		status, out := call(t, srv, "POST", "/mcp/servers", `{"name":"`+tc.name+`","url":"`+tc.url+`","auth":"header","token":"synthetic-token"}`)
		if status != 400 || errorCode(out) != "NAME_RESERVED" {
			t.Fatalf("%s %s: %d %v", tc.name, tc.url, status, out)
		}
	}
	if len(recorder.bodies) != 0 {
		t.Fatalf("a reserved name reached the host program: %v", recorder.bodies)
	}
	// openedbot's own install path keeps working, for both tools.
	for _, tc := range []struct{ name, url string }{
		{"openedbot_routines", "https://api.example/api/mcp/routines/" + org},
		{"openedbot_bot_settings", "https://api.example/api/mcp/bot-settings/" + org},
	} {
		if status, out := call(t, srv, "POST", "/mcp/servers", `{"name":"`+tc.name+`","url":"`+tc.url+`","auth":"header","token":"synthetic-token","replace":true}`); status != 200 {
			t.Fatalf("%s: %d %v", tc.name, status, out)
		}
	}
}
