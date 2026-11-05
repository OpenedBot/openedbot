package operator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeFlow is the MCP OAuth program: events on Lines, the callback on Deliver.
type fakeFlow struct {
	lines     chan string
	done      chan struct{}
	err       error
	kills     int
	delivered []string
}

func newFakeFlow() *fakeFlow {
	return &fakeFlow{lines: make(chan string, 16), done: make(chan struct{})}
}
func (f *fakeFlow) Lines() <-chan string { return f.lines }
func (f *fakeFlow) Wait() error          { <-f.done; return f.err }
func (f *fakeFlow) Kill()                { f.kills++; f.finish(errors.New("killed")) }
func (f *fakeFlow) Deliver(line []byte) error {
	f.delivered = append(f.delivered, strings.TrimSpace(string(line)))
	return nil
}
func (f *fakeFlow) finish(err error) {
	select {
	case <-f.done:
		return
	default:
	}
	f.err = err
	close(f.lines)
	close(f.done)
}

func TestMCPOAuthLifecycleIsProvenByTheProgramNotByTheCallback(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	marker := filepath.Join(t.TempDir(), "pending")
	flow := newFakeFlow()
	var started []string
	s := &Server{
		Probe:         (&probeRecorder{}).probe(),
		RestartMarker: marker,
		Now:           func() time.Time { return now },
		StartMCPOAuth: func(_ context.Context, server, _ string, redirect string) (OAuthFlow, error) {
			started = append(started, server+" "+redirect)
			// The URL is printed before the handler answers.
			flow.lines <- `{"event":"authorization_url","url":"https://mcp.notion.com/authorize?state=abc&code_challenge=x"}`
			return flow, nil
		},
	}
	srv := serve(t, s)
	if got := s.features(); len(got) != 7 || got[5] != "mcp_oauth" || got[6] != SkillsInventoryFeature {
		t.Fatalf("features %v", got)
	}

	status, out := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/api/mcp-oauth/callback/rt-1/notion"}`)
	if status != 200 || out["status"] != StatusPending || out["authorizationUrl"] != "https://mcp.notion.com/authorize?state=abc&code_challenge=x" {
		t.Fatalf("%d %v", status, out)
	}
	if started[0] != "notion https://openedbot.example/api/mcp-oauth/callback/rt-1/notion" {
		t.Fatalf("started %v", started)
	}
	id := out["sessionId"].(string)
	// A second start for the same server returns the pending one.
	if st, dup := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb"}`); st != 409 || dup["session"].(map[string]any)["sessionId"] != id {
		t.Fatalf("%d %v", st, dup)
	}
	// The callback names the server, not the session, and reaches the program's stdin verbatim.
	st, cb := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"auth-code","state":"abc"}`)
	if st != 200 || cb["status"] != StatusPending || len(flow.delivered) != 1 || flow.delivered[0] != `{"code":"auth-code","error":"","state":"abc"}` {
		t.Fatalf("%d %v %v", st, cb, flow.delivered)
	}
	// A second callback reaches the program too: it decides (state check),
	// the operator does not. The RFC 9207 issuer rides along when the
	// provider sent one (the MCP SDK refuses a redirect without it when the
	// server advertises it).
	if st, _ := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"again","state":"abc","iss":"https://mcp.notion.com"}`); st != 200 || len(flow.delivered) != 2 ||
		flow.delivered[1] != `{"code":"again","error":"","iss":"https://mcp.notion.com","state":"abc"}` {
		t.Fatalf("second callback %d %v", st, flow.delivered)
	}
	// An issuer with a control character is refused before the program.
	if st, _ := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"c","state":"abc","iss":"https://x\u0007"}`); st != 400 || len(flow.delivered) != 2 {
		t.Fatalf("control character in iss %d %v", st, flow.delivered)
	}
	// A retried attempt publishes a fresh URL: the session carries the latest.
	flow.lines <- `{"event":"diagnostic","text":"callback rejected: OAuth callback state mismatch"}`
	flow.lines <- `{"event":"authorization_url","url":"https://mcp.notion.com/authorize?state=def"}`
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/mcp/servers/notion/oauth/"+id, "")
		return v["authorizationUrl"] == "https://mcp.notion.com/authorize?state=def"
	})
	// The callback alone proves nothing: still pending, no marker.
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("marker written before the program proved the token")
	}
	flow.lines <- `{"event":"approved","tools":["search","fetch"]}`
	flow.finish(nil)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/mcp/servers/notion/oauth/"+id, "")
		return v["status"] == StatusConnected
	})
	_, v := call(t, srv, "GET", "/mcp/servers/notion/oauth/"+id, "")
	if tools, _ := v["discoveredTools"].([]any); len(tools) != 2 || tools[0] != "search" {
		t.Fatalf("%v", v)
	}
	// Approved: the gateway has not loaded the token, and the page must say so.
	// The marker follows the status, written once the session lock is released.
	waitFor(t, func() bool { _, err := os.Stat(marker); return err == nil })
	if st, _ := call(t, srv, "GET", "/mcp/servers/linear/oauth/"+id, ""); st != 404 {
		t.Fatalf("cross-server read: %d", st)
	}
}

func TestMCPOAuthFailsClosedOnAProgramErrorAndKeepsItsCode(t *testing.T) {
	flow := newFakeFlow()
	s := &Server{
		Probe:         (&probeRecorder{}).probe(),
		StartMCPOAuth: func(context.Context, string, string, string) (OAuthFlow, error) { return flow, nil },
	}
	srv := serve(t, s)
	go func() {
		flow.lines <- `{"event":"error","code":"OAUTH_REGISTRATION_REFUSED","message":"the provider refused to register an OAuth client for this host"}`
		flow.finish(nil)
	}()
	status, out := call(t, srv, "POST", "/mcp/servers/figma/oauth", `{"redirectUri":"https://openedbot.example/cb"}`)
	if status != 200 || out["status"] != StatusFailed || out["errorCode"] != "OAUTH_REGISTRATION_REFUSED" || out["authorizationUrl"] != nil {
		t.Fatalf("%d %v", status, out)
	}
	// An out-of-contract code never crosses with its text.
	flow2 := newFakeFlow()
	s.StartMCPOAuth = func(context.Context, string, string, string) (OAuthFlow, error) { return flow2, nil }
	go func() {
		flow2.lines <- `{"event":"error","code":"Traceback","message":"/home/hermes/.hermes/config.yaml: token=sk-live"}`
		flow2.finish(nil)
	}()
	_, out = call(t, srv, "POST", "/mcp/servers/figma/oauth", `{"redirectUri":"https://openedbot.example/cb"}`)
	if out["errorCode"] != "OAUTH_FAILED" || strings.Contains(out["error"].(string), "sk-live") {
		t.Fatalf("%v", out)
	}
	// A program that ends without a verdict is a failure, never a success.
	flow3 := newFakeFlow()
	s.StartMCPOAuth = func(context.Context, string, string, string) (OAuthFlow, error) { return flow3, nil }
	go func() {
		flow3.lines <- `{"event":"authorization_url","url":"https://auth.example/a?state=s"}`
		flow3.finish(errors.New("exit 2"))
	}()
	_, out = call(t, srv, "POST", "/mcp/servers/figma/oauth", `{"redirectUri":"https://openedbot.example/cb"}`)
	id := out["sessionId"].(string)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/mcp/servers/figma/oauth/"+id, "")
		return v["status"] == StatusFailed
	})
}

func TestMCPOAuthRefusals(t *testing.T) {
	s := &Server{Probe: (&probeRecorder{}).probe()}
	srv := serve(t, s)
	// No program installed: not announced, and refused when asked anyway.
	if got := s.features(); len(got) != 6 || got[2] != "mcp_management" || got[3] != "profile_inventory" || got[4] != "model_context" || got[5] != SkillsInventoryFeature {
		t.Fatalf("features %v", got)
	}
	if st, out := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb"}`); st != 503 || errorCode(out) != "OAUTH_UNAVAILABLE" {
		t.Fatalf("%d %v", st, out)
	}
	flow := newFakeFlow()
	s.StartMCPOAuth = func(context.Context, string, string, string) (OAuthFlow, error) { return flow, nil }
	for _, c := range []struct{ path, body, code string }{
		{"/mcp/servers/bad%20name/oauth", `{"redirectUri":"https://openedbot.example/cb"}`, "NAME_INVALID"},
		{"/mcp/servers/notion/oauth", `{}`, "REDIRECT_INVALID"},
		{"/mcp/servers/notion/oauth", `{"redirectUri":"http://openedbot.example/cb"}`, "REDIRECT_INVALID"},
		{"/mcp/servers/notion/oauth", `{"redirectUri":"javascript:alert(1)"}`, "REDIRECT_INVALID"},
		{"/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb x"}`, "REDIRECT_INVALID"},
		{"/mcp/servers/notion/oauth/callback", `{}`, "BODY_INVALID"},
		{"/mcp/servers/notion/oauth/callback", `{"code":"c","state":"s"}`, "OAUTH_SESSION_NOT_FOUND"},
	} {
		st, out := call(t, srv, "POST", c.path, c.body)
		if errorCode(out) != c.code || st < 400 {
			t.Fatalf("%s %s → %d %v", c.path, c.body, st, out)
		}
	}
	if len(flow.delivered) != 0 {
		t.Fatalf("a refused request reached the program: %v", flow.delivered)
	}
	// A loopback http origin is the development openedbot: accepted.
	go func() { flow.lines <- `{"event":"authorization_url","url":"https://auth.example/a?state=s"}` }()
	if st, out := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"http://localhost:3100/api/mcp-oauth/callback/rt/notion"}`); st != 200 || out["status"] != StatusPending {
		t.Fatalf("%d %v", st, out)
	}
}

func TestMCPOAuthCancelAndExpiryKillTheProgram(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	flow := newFakeFlow()
	s := &Server{
		Probe:         (&probeRecorder{}).probe(),
		Now:           func() time.Time { return now },
		StartMCPOAuth: func(context.Context, string, string, string) (OAuthFlow, error) { return flow, nil },
	}
	srv := serve(t, s)
	go func() { flow.lines <- `{"event":"authorization_url","url":"https://auth.example/a?state=s"}` }()
	_, out := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb"}`)
	id := out["sessionId"].(string)
	if st, _ := call(t, srv, "DELETE", "/mcp/servers/notion/oauth/"+id, ""); st != 204 || flow.kills != 1 {
		t.Fatalf("%d kills=%d", st, flow.kills)
	}
	if _, v := call(t, srv, "GET", "/mcp/servers/notion/oauth/"+id, ""); v["status"] != StatusCancelled {
		t.Fatalf("%v", v)
	}

	flow2 := newFakeFlow()
	s.StartMCPOAuth = func(context.Context, string, string, string) (OAuthFlow, error) { return flow2, nil }
	go func() { flow2.lines <- `{"event":"authorization_url","url":"https://auth.example/a?state=s"}` }()
	_, out = call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb"}`)
	id = out["sessionId"].(string)
	now = now.Add(16 * time.Minute)
	if _, v := call(t, srv, "GET", "/mcp/servers/notion/oauth/"+id, ""); v["status"] != StatusFailed || v["errorCode"] != "OAUTH_TIMEOUT" || flow2.kills != 1 {
		t.Fatalf("%v kills=%d", v, flow2.kills)
	}
}

// A bot-level connection authorizes the server for ONE named profile: the
// program receives that profile, and a slug the host would refuse never
// starts a program. `mcp_oauth_profile` is announced only by a multiplexing
// host, the only one whose profiles have their own runs.
func TestMCPOAuthCarriesTheNamedProfileAndRefusesAnInvalidOne(t *testing.T) {
	flow := newFakeFlow()
	var profiles []string
	s := &Server{
		Probe: (&probeRecorder{}).probe(),
		StartMCPOAuth: func(_ context.Context, _ string, profile string, _ string) (OAuthFlow, error) {
			profiles = append(profiles, profile)
			flow.lines <- `{"event":"authorization_url","url":"https://mcp.linear.app/authorize?state=p"}`
			return flow, nil
		},
	}
	srv := serve(t, s)
	for _, body := range []string{
		`{"redirectUri":"https://openedbot.example/cb","profile":"default"}`,
		`{"redirectUri":"https://openedbot.example/cb","profile":"Dev"}`,
		`{"redirectUri":"https://openedbot.example/cb","profile":"../root"}`,
	} {
		if status, out := call(t, srv, "POST", "/mcp/servers/linear/oauth", body); status != 400 || out["error"].(map[string]any)["code"] != "PROFILE_INVALID" {
			t.Fatalf("%s: %d %v", body, status, out)
		}
	}
	if len(profiles) != 0 {
		t.Fatalf("a refused profile started the program: %v", profiles)
	}
	if status, out := call(t, srv, "POST", "/mcp/servers/linear/oauth", `{"redirectUri":"https://openedbot.example/cb","profile":"dev"}`); status != 200 || out["status"] != StatusPending {
		t.Fatalf("%d %v", status, out)
	}
	if len(profiles) != 1 || profiles[0] != "dev" {
		t.Fatalf("profiles %v", profiles)
	}
	flow.finish(nil)

	if hasFeature(s.features(), "mcp_oauth_profile") {
		t.Fatal("mcp_oauth_profile announced by a host that does not multiplex profiles")
	}
	s.mu.Lock()
	s.Multiplex = true
	s.mu.Unlock()
	if !hasFeature(s.features(), "mcp_oauth_profile") {
		t.Fatal("mcp_oauth_profile not announced by a multiplexing host with the OAuth program")
	}
}

func hasFeature(features []string, name string) bool {
	for _, feature := range features {
		if feature == name {
			return true
		}
	}
	return false
}
