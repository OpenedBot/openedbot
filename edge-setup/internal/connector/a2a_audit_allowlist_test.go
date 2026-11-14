package connector

import "testing"

func TestA2AAuditHasOneBoundedRootQuery(t *testing.T) {
	for _, path := range []string{"/hermes-setup/a2a/audit", "/hermes-setup/a2a/audit?limit=1", "/hermes-setup/a2a/audit?limit=50", "/hermes-setup/a2a/audit?limit=100"} {
		if route := Match("GET", path); route == nil || !route.Host {
			t.Fatalf("bounded host read rejected: %s", path)
		}
	}
	for _, path := range []string{"/hermes-setup/a2a/audit?", "/hermes-setup/a2a/audit?limit=0", "/hermes-setup/a2a/audit?limit=101", "/hermes-setup/a2a/audit?limit=01", "/hermes-setup/a2a/audit?limit=1&limit=2", "/hermes-setup/a2a/audit?limit=50&path=other", "/p/alpha/hermes-setup/a2a/audit?limit=50"} {
		if Match("GET", path) != nil {
			t.Fatalf("unbounded host query admitted: %s", path)
		}
	}
	if Match("POST", "/hermes-setup/a2a/audit") != nil {
		t.Fatal("an audit write was admitted")
	}
}
