package operator

import (
	"context"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

// hostileSegments are path values a compromised or buggy caller could put
// where a route expects a slug, a provider or a name: traversal, shell
// metacharacters, an option, whitespace, control bytes, unicode lookalikes
// and oversize input. None of them may reach a process.
var hostileSegments = []string{
	"..", "../etc", "a/../b", "-rf", "--config=/etc/shadow", "a;id", "a|id", "a&&id",
	"$(id)", "`id`", "a b", "a\tb", "a\nb", "a\x00b", "A\u0301", "ﬁle", "*",
	strings.Repeat("a", 300),
}

// routesWithSegments lists every route whose path carries caller input,
// with {} marking the hostile segment. Other segments are valid.
var routesWithSegments = []struct{ method, path, body string }{
	{"POST", "/providers/{}/credentials", `{"apiKey":"sk-test","label":"main"}`},
	{"POST", "/providers/{}/oauth", `{}`},
	{"GET", "/providers/{}/oauth/abc", ``},
	{"GET", "/providers/anthropic/oauth/{}", ``},
	{"DELETE", "/providers/{}/oauth/abc", ``},
	{"DELETE", "/providers/anthropic/oauth/{}", ``},
	{"POST", "/toolsets/{}", `{"enabled":true}`},
	{"POST", "/mcp/catalog/{}", `{}`},
	{"DELETE", "/mcp/servers/{}", ``},
	{"POST", "/mcp/servers/{}/oauth", `{"redirectUri":"https://console.example/cb"}`},
	{"GET", "/mcp/servers/{}/oauth/abc", ``},
	{"GET", "/mcp/servers/linear/oauth/{}", ``},
	{"DELETE", "/mcp/servers/{}/oauth/abc", ``},
	{"GET", "/gateway/restart/{}", ``},
	{"GET", "/profiles/{}/avatar", ``},
	{"DELETE", "/profiles/{}", ``},
	{"POST", "/profiles/{}/toolsets/web", `{"enabled":true}`},
	{"POST", "/profiles/dev/toolsets/{}", `{"enabled":true}`},
	{"GET", "/profiles/{}/memory", ``},
	{"POST", "/profiles/{}/memory", `{"content":"x"}`},
	{"POST", "/profiles/{}/mcp/servers/linear", `{"enabled":true}`},
	{"POST", "/profiles/dev/mcp/servers/{}", `{"enabled":true}`},
	{"DELETE", "/profiles/{}/mcp/servers/linear", ``},
	{"DELETE", "/profiles/dev/mcp/servers/{}", ``},
	{"POST", "/profiles/{}/model", `{"provider":"anthropic","model":"claude"}`},
	{"GET", "/profiles/{}/approval-policy", ``},
	{"PUT", "/profiles/{}/approval-policy", `{}`},
	{"POST", "/profiles/{}/skills/x", `{"enabled":true}`},
	{"POST", "/profiles/dev/skills/{}", `{"enabled":true}`},
	{"POST", "/profiles/{}/bundled-skills", `{}`},
	{"POST", "/profiles/{}/providers/anthropic/credentials", `{"apiKey":"sk-test"}`},
	{"POST", "/profiles/dev/providers/{}/credentials", `{"apiKey":"sk-test"}`},
	{"DELETE", "/profiles/{}/providers/anthropic/credentials", ``},
	{"DELETE", "/profiles/dev/providers/{}/credentials", ``},
	{"POST", "/profiles/{}/skills/hub/scan", `{}`},
	{"POST", "/profiles/{}/skills/hub/install", `{}`},
	{"GET", "/profiles/{}/skills/hub/operations/abc", ``},
	{"GET", "/profiles/dev/skills/hub/operations/{}", ``},
	{"DELETE", "/profiles/{}/skills/x", ``},
	{"DELETE", "/profiles/dev/skills/{}", ``},
	{"POST", "/a2a/peers/{}/trust", `{}`},
	{"POST", "/a2a/peers/{}/token", `{}`},
	{"DELETE", "/a2a/peers/{}/token", ``},
}

type execCounter struct {
	mu    sync.Mutex
	verbs []string
}

func (c *execCounter) add(v string) {
	c.mu.Lock()
	c.verbs = append(c.verbs, v)
	c.mu.Unlock()
}

func (c *execCounter) all() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.verbs...)
}

// hostileServer wires every dependency of the operator to a recorder, so a
// request that reaches any process, probe or writer is seen.
func hostileServer(t *testing.T) (*execCounter, *exectest.Fake, *httptest.Server) {
	t.Helper()
	seen := &execCounter{}
	fake := exectest.NewFake()
	s := &Server{
		Runner:    fake,
		Multiplex: true,
		Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
			seen.add("probe:" + verb)
			return []byte(`{"error":{"code":"HOST_FAILED","message":"x"}}`), nil
		},
		Inventory: func(context.Context) ([]byte, error) { seen.add("inventory"); return []byte(`{}`), nil },
		ProfileInventory: func(_ context.Context, p string) ([]byte, error) {
			seen.add("profile-inventory:" + p)
			return []byte(`{}`), nil
		},
		ProfileCatalogue: func(_ context.Context, p string) ([]byte, error) {
			seen.add("profile-catalogue:" + p)
			return []byte(`{}`), nil
		},
		Catalogue: func(context.Context) ([]byte, error) { seen.add("catalogue"); return []byte(`{}`), nil },
		StartLogin: func(_ context.Context, p string) (Login, error) {
			seen.add("login:" + p)
			l := newFakeLogin()
			l.finish(nil)
			return l, nil
		},
		StartMCPOAuth: func(_ context.Context, server, profile, _ string) (OAuthFlow, error) {
			seen.add("mcp-oauth:" + server + ":" + profile)
			return nil, context.Canceled
		},
		RestartGateway: func(context.Context) error { seen.add("restart"); return nil },
		Sessions: func(_ context.Context, p string, _ int) ([]byte, error) {
			seen.add("sessions:" + p)
			return []byte(`{}`), nil
		},
		ApprovalPolicyRead: func(_ context.Context, p string) (approvalPolicyState, error) {
			seen.add("approval-read:" + p)
			return approvalPolicyState{}, nil
		},
		ApprovalPolicyWrite: func(_ context.Context, p string, _ approvalPolicyRequest) (approvalPolicyState, error) {
			seen.add("approval-write:" + p)
			return approvalPolicyState{}, nil
		},
		SkillsOperationDir: t.TempDir(),
		Now:                func() time.Time { return time.Unix(1_800_000_000, 0) },
		Logf:               func(string, ...any) {},
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return seen, fake, srv
}

func TestHostilePathSegmentsNeverReachAProcess(t *testing.T) {
	for _, route := range routesWithSegments {
		for _, bad := range hostileSegments {
			seen, fake, srv := hostileServer(t)
			path := strings.Replace(route.path, "{}", url.PathEscape(bad), 1)
			code, _ := call(t, srv, route.method, path, route.body)
			if code < 400 || code >= 500 {
				t.Errorf("%s %s (%q) = %d, want a 4xx refusal", route.method, route.path, bad, code)
			}
			if got := seen.all(); len(got) != 0 {
				t.Errorf("%s %s (%q) reached %v", route.method, route.path, bad, got)
			}
			if len(fake.Calls) != 0 {
				t.Errorf("%s %s (%q) ran %v", route.method, route.path, bad, fake.Commands())
			}
		}
	}
}

func TestOnlyNamedVerbsAreRouted(t *testing.T) {
	for _, probe := range []struct{ method, path string }{
		{"POST", "/exec"},
		{"POST", "/run"},
		{"POST", "/shell"},
		{"GET", "/providers/anthropic/credentials/../../../etc/passwd"},
		{"PUT", "/capabilities"},
		{"POST", "/gateway/restart/../../exec"},
		{"POST", "/profiles//toolsets/web"},
		{"POST", "/mcp/servers/a%2Fb/oauth"},
	} {
		seen, fake, srv := hostileServer(t)
		code, out := call(t, srv, probe.method, probe.path, `{"command":"id","args":["-a"]}`)
		if code != 404 && code != 405 && code != 400 {
			t.Errorf("%s %s = %d %v, want a refusal", probe.method, probe.path, code, out)
		}
		if len(seen.all()) != 0 || len(fake.Calls) != 0 {
			t.Errorf("%s %s reached %v / %v", probe.method, probe.path, seen.all(), fake.Commands())
		}
	}
}

func TestMCPBodiesAreValidatedBeforeAnyProbe(t *testing.T) {
	cases := []struct{ name, path, body, code string }{
		{"stdio command", "/mcp/servers", `{"name":"x","url":"https://a.example","command":"sh"}`, "STDIO_REFUSED"},
		{"bad name", "/mcp/servers", `{"name":"a;id","url":"https://a.example"}`, "NAME_INVALID"},
		{"plain http", "/mcp/servers", `{"name":"x","url":"http://a.example"}`, "URL_INVALID"},
		{"file url", "/mcp/servers", `{"name":"x","url":"file:///etc/shadow"}`, "URL_INVALID"},
		{"userinfo", "/mcp/servers", `{"name":"x","url":"https://u:p@a.example"}`, "URL_INVALID"},
		{"newline in url", "/mcp/servers", `{"name":"x","url":"https://a.example/\nX"}`, "URL_INVALID"},
		{"long url", "/mcp/servers", `{"name":"x","url":"https://a.example/` + strings.Repeat("a", 2100) + `"}`, "URL_INVALID"},
		{"unknown auth", "/mcp/servers", `{"name":"x","url":"https://a.example","auth":"basic"}`, "AUTH_INVALID"},
		{"header without token", "/mcp/servers", `{"name":"x","url":"https://a.example","auth":"header"}`, "SECRET_INVALID"},
		{"token with a newline", "/mcp/servers", `{"name":"x","url":"https://a.example","auth":"header","token":"a\nb"}`, "SECRET_INVALID"},
		{"catalogue body names another entry", "/mcp/catalog/linear", `{"name":"evil"}`, "NAME_INVALID"},
		{"catalogue env key", "/mcp/catalog/linear", `{"env":{"LD_PRELOAD;x":"v"}}`, "ENV_INVALID"},
		{"catalogue lowercase env key", "/mcp/catalog/linear", `{"env":{"path":"v"}}`, "ENV_INVALID"},
		{"catalogue env value control", "/mcp/catalog/linear", `{"env":{"API_KEY":"a\u0000b"}}`, "ENV_INVALID"},
		{"catalogue empty env value", "/mcp/catalog/linear", `{"env":{"API_KEY":""}}`, "ENV_INVALID"},
	}
	for _, tc := range cases {
		seen, fake, srv := hostileServer(t)
		code, out := call(t, srv, "POST", tc.path, tc.body)
		errObj, _ := out["error"].(map[string]any)
		if code != 400 || errObj["code"] != tc.code {
			t.Errorf("%s: %d %v, want 400 %s", tc.name, code, out, tc.code)
		}
		if len(seen.all()) != 0 || len(fake.Calls) != 0 {
			t.Errorf("%s reached %v / %v", tc.name, seen.all(), fake.Commands())
		}
	}
}

func TestMCPCatalogueInstallSendsTheRouteName(t *testing.T) {
	recorder := &probeRecorder{replies: map[string]string{"mcp-install": `{"server":{"name":"linear","transport":"http"}}`}}
	s := &Server{Probe: recorder.probe()}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	code, out := call(t, srv, "POST", "/mcp/catalog/linear", `{"name":"linear","env":{"LINEAR_API_KEY":"lin_x"}}`)
	if code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	if len(recorder.bodies) != 1 || !strings.Contains(recorder.bodies[0], `"name":"linear"`) {
		t.Fatalf("probe bodies %v", recorder.bodies)
	}
	code, _ = call(t, srv, "POST", "/mcp/catalog/linear", `{}`)
	if code != 200 || !strings.Contains(recorder.bodies[1], `"name":"linear"`) {
		t.Fatalf("an empty body must install the route entry: %d %v", code, recorder.bodies)
	}
}

func TestEveryRouteWildcardHasAGrammar(t *testing.T) {
	// Handler panics on a wildcard without a grammar; building it is the test.
	(&Server{}).Handler()
	for name, re := range wildcardGrammar {
		// "." and ".." are refused by the gate itself (sessionRe admits dots).
		if re.MatchString("") || re.MatchString("a/b") || re.MatchString("a b") || re.MatchString("-x;y") {
			t.Errorf("grammar of {%s} admits a path-like value", name)
		}
		if _, ok := wildcardRefusal[name]; !ok {
			t.Errorf("{%s} has no refusal", name)
		}
	}
}
