package connector

import "testing"

func TestA2APeersAreNamedRootRoutesWithoutQueries(t *testing.T) {
	for _, endpoint := range []struct{ method, path string }{
		{"GET", "/hermes-setup/a2a/peers"},
		{"POST", "/hermes-setup/a2a/peers/alpha.bot/trust"},
		{"POST", "/hermes-setup/a2a/peers/alpha.bot/token"},
		{"DELETE", "/hermes-setup/a2a/peers/alpha.bot/token"},
	} {
		if route := Match(endpoint.method, endpoint.path); route == nil || !route.Host || route.Events {
			t.Fatal("named host policy route was not accepted")
		}
		for _, denied := range []string{endpoint.path + "?", endpoint.path + "?runtimeId=other", "/p/demo" + endpoint.path} {
			if Match(endpoint.method, denied) != nil {
				t.Fatal("a policy query or profile wrapper was accepted")
			}
		}
	}
	for _, path := range []string{"/hermes-setup/a2a/peers/Alpha/trust", "/hermes-setup/a2a/peers/a..b/trust", "/hermes-setup/a2a/peers/a%2Fb/trust", "/hermes-setup/a2a/peers/a/exec", "/hermes-setup/a2a/peers/a/restart", "/hermes-setup/a2a/message/send"} {
		if Match("POST", path) != nil {
			t.Fatal("an unbounded or non-policy operation was accepted")
		}
	}
}
