package enroll

import "testing"

func TestParseTicketAndURL(t *testing.T) {
	tk, err := ParseTicket("2b5a1f3e-7c2d-4e8a-9b1c-0d1e2f3a4b5c.Qm9vbXNoYWthbGFrYTEyMzQ1Njc4OTA")
	if err != nil || tk.ID != "2b5a1f3e-7c2d-4e8a-9b1c-0d1e2f3a4b5c" {
		t.Fatalf("%v %+v", err, tk)
	}
	for _, bad := range []string{"", "abc", "notauuid.secretsecretsecret", "2b5a1f3e-7c2d-4e8a-9b1c-0d1e2f3a4b5c.short"} {
		if _, err := ParseTicket(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if _, err := ParseOpenedbotURL("https://console.openedbot.app", false); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"http://console.openedbot.app", "https://u:p@console.openedbot.app", "https://console.openedbot.app/api", "https://console.openedbot.app/?x=1"} {
		if _, err := ParseOpenedbotURL(bad, false); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// The development escape hatch is loopback-only: an SSH reverse tunnel puts
// the workstation on this host's own loopback, so nothing travels in clear
// text on the wire. A public http:// origin stays refused with the flag on.
func TestParseOpenedbotURLInsecureLoopback(t *testing.T) {
	for _, good := range []string{"http://127.0.0.1:8790", "http://localhost:8790", "http://[::1]:8790", "http://localhost:8790/"} {
		u, err := ParseOpenedbotURL(good, true)
		if err != nil {
			t.Errorf("%q refused: %v", good, err)
			continue
		}
		if u.Path != "" {
			t.Errorf("%q kept path %q", good, u.Path)
		}
	}
	for _, bad := range []string{
		"http://console.openedbot.app",
		"http://8.8.8.8:8790",
		"http://10.0.0.20:8790",
		"http://localhost.attacker.example",
		"http://u:p@127.0.0.1:8790",
		"http://127.0.0.1:8790/api",
		"ftp://127.0.0.1:8790",
	} {
		if _, err := ParseOpenedbotURL(bad, true); err == nil {
			t.Errorf("%q accepted with --insecure-openedbot", bad)
		}
	}
	// Without the flag the loopback origin is refused like any other http one.
	if _, err := ParseOpenedbotURL("http://127.0.0.1:8790", false); err == nil {
		t.Error("loopback accepted without --insecure-openedbot")
	}
}
