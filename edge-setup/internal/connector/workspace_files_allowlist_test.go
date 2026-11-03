package connector

import "testing"

func TestWorkspaceFileIsOneBoundedNameAtTheRoot(t *testing.T) {
	for _, path := range []string{"/hermes-setup/workspace/files/chart.png", "/hermes-setup/workspace/files/rapport_2026-11.pdf", "/hermes-setup/workspace/files/a.jpeg"} {
		if route := Match("GET", path); route == nil || !route.Host || route.Events {
			t.Fatalf("%s was not accepted", path)
		}
		for _, denied := range []string{path + "?", path + "?path=/etc/passwd", "/p/demo" + path} {
			if Match("GET", denied) != nil {
				t.Fatalf("%s was accepted", denied)
			}
		}
		if Match("POST", path) != nil || Match("DELETE", path) != nil {
			t.Fatal("a write on a workspace file was accepted")
		}
	}
	for _, path := range []string{
		"/hermes-setup/workspace/files/sub/chart.png",
		"/hermes-setup/workspace/files/../runtime.env",
		"/hermes-setup/workspace/files/.env.png",
		"/hermes-setup/workspace/files/a%2Fb.png",
		"/hermes-setup/workspace/files/notes.txt",
		"/hermes-setup/workspace/files/chart.PNG",
		"/hermes-setup/workspace/files/",
	} {
		if Match("GET", path) != nil {
			t.Fatalf("%s was accepted", path)
		}
	}
}
