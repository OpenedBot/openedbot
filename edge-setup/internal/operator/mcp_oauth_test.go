package operator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	// The same callback again (a reloaded return page) is a replay: refused
	// for what it is, never relayed nor reported as received.
	if st, out := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"again","state":"abc"}`); st != 409 || errorCode(out) != "OAUTH_CALLBACK_USED" || len(flow.delivered) != 1 {
		t.Fatalf("replayed callback %d %v %v", st, out, flow.delivered)
	}
	// A state the pending authorization never published fails visibly.
	if st, out := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"c","state":"forged"}`); st != 400 || errorCode(out) != "OAUTH_CALLBACK_INVALID" || len(flow.delivered) != 1 {
		t.Fatalf("unknown state %d %v %v", st, out, flow.delivered)
	}
	// An issuer with a control character is refused before the program.
	if st, _ := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"c","state":"abc","iss":"https://x\u0007"}`); st != 400 || len(flow.delivered) != 1 {
		t.Fatalf("control character in iss %d %v", st, flow.delivered)
	}
	// A retried attempt publishes a fresh URL: the session carries the latest.
	flow.lines <- `{"event":"diagnostic","text":"callback rejected: OAuth callback state mismatch"}`
	flow.lines <- `{"event":"authorization_url","url":"https://mcp.notion.com/authorize?state=def"}`
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/mcp/servers/notion/oauth/"+id, "")
		return v["authorizationUrl"] == "https://mcp.notion.com/authorize?state=def"
	})
	// The previous attempt's state is no longer the expected one.
	if st, out := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"late","state":"stale"}`); st != 400 || errorCode(out) != "OAUTH_CALLBACK_INVALID" {
		t.Fatalf("stale state %d %v", st, out)
	}
	// The new attempt's callback reaches the program. The RFC 9207 issuer
	// rides along when the provider sent one (the MCP SDK refuses a redirect
	// without it when the server advertises it).
	if st, _ := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"again","state":"def","iss":"https://mcp.notion.com"}`); st != 200 || len(flow.delivered) != 2 ||
		flow.delivered[1] != `{"code":"again","error":"","iss":"https://mcp.notion.com","state":"def"}` {
		t.Fatalf("second attempt callback %d %v", st, flow.delivered)
	}
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
	// Once connected, the same callback replayed is still a replay, and any
	// other one finds nothing waiting: neither is « received ».
	if st, out := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"again","state":"def"}`); st != 409 || errorCode(out) != "OAUTH_CALLBACK_USED" {
		t.Fatalf("replay after the end %d %v", st, out)
	}
	if st, out := call(t, srv, "POST", "/mcp/servers/notion/oauth/callback", `{"code":"c","state":"other"}`); st != 404 || errorCode(out) != "OAUTH_SESSION_NOT_FOUND" {
		t.Fatalf("callback after the end %d %v", st, out)
	}
	if len(flow.delivered) != 2 {
		t.Fatalf("a refused callback reached the program: %v", flow.delivered)
	}
}

// Two bots, one server: the host keeps one authorization per server (the
// callback is relayed by server name), and its 409 names the profile of the
// one in progress, so openedbot never takes bot A's session for bot B's.
func TestMCPOAuthConflictNamesTheProfileOfThePendingAuthorization(t *testing.T) {
	flow := newFakeFlow()
	starts := 0
	s := &Server{
		Probe: (&probeRecorder{}).probe(),
		StartMCPOAuth: func(context.Context, string, string, string) (OAuthFlow, error) {
			starts++
			flow.lines <- `{"event":"authorization_url","url":"https://mcp.notion.com/authorize?state=a"}`
			return flow, nil
		},
	}
	srv := serve(t, s)
	status, out := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb","profile":"alpha"}`)
	if status != 200 || out["profile"] != "alpha" {
		t.Fatalf("%d %v", status, out)
	}
	id := out["sessionId"].(string)
	for _, c := range []struct{ body, profile string }{
		{`{"redirectUri":"https://openedbot.example/cb","profile":"beta"}`, "alpha"},
		{`{"redirectUri":"https://openedbot.example/cb","profile":"alpha"}`, "alpha"},
		{`{"redirectUri":"https://openedbot.example/cb"}`, "alpha"},
	} {
		st, conflict := call(t, srv, "POST", "/mcp/servers/notion/oauth", c.body)
		session, _ := conflict["session"].(map[string]any)
		if st != 409 || errorCode(conflict) != "MCP_OAUTH_IN_PROGRESS" || session["sessionId"] != id || session["profile"] != c.profile {
			t.Fatalf("%s: %d %v", c.body, st, conflict)
		}
	}
	if starts != 1 {
		t.Fatalf("a conflicting start ran the program: %d", starts)
	}
	// Cancelled, the server is free for the next bot.
	if st, _ := call(t, srv, "DELETE", "/mcp/servers/notion/oauth/"+id, ""); st != 204 {
		t.Fatalf("cancel %d", st)
	}
	flow = newFakeFlow()
	if st, next := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb","profile":"beta"}`); st != 200 || next["profile"] != "beta" {
		t.Fatalf("%d %v", st, next)
	}
	// The runtime root's authorization says so with a null profile.
	flow.finish(nil)
	flow = newFakeFlow()
	if st, root := call(t, srv, "POST", "/mcp/servers/linear/oauth", `{"redirectUri":"https://openedbot.example/cb"}`); st != 200 || root["profile"] != nil {
		t.Fatalf("%d %v", st, root)
	} else if _, present := root["profile"]; !present {
		t.Fatalf("the root session omits profile: %v", root)
	}
}

// lockingFlow is a fakeFlow whose deliveries may be read while the follower
// goroutine writes them.
type lockingFlow struct {
	*fakeFlow
	mu        sync.Mutex
	delivered []string
}

func (f *lockingFlow) Deliver(line []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.delivered = append(f.delivered, strings.TrimSpace(string(line)))
	return nil
}

func (f *lockingFlow) deliveries() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.delivered...)
}

// The OAuth program rewrites the profile's config.yaml once the token is
// proven. It does so under the same lock as the probe verbs that rewrite that
// file (a capability or model toggle): the lock is granted only when free,
// held until the verdict, and never for the minutes spent at the provider.
func TestMCPOAuthSaveTakesTheProfileConfigLock(t *testing.T) {
	flow := &lockingFlow{fakeFlow: newFakeFlow()}
	s := &Server{
		Probe: (&probeRecorder{}).probe(),
		StartMCPOAuth: func(context.Context, string, string, string) (OAuthFlow, error) {
			flow.lines <- `{"event":"authorization_url","url":"https://mcp.notion.com/authorize?state=a"}`
			return flow, nil
		},
	}
	srv := serve(t, s)
	if st, out := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb","profile":"dev"}`); st != 200 {
		t.Fatalf("%d %v", st, out)
	}
	// While the person is at the provider, nothing holds the profile's lock.
	free := func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		unlock, err := s.lockConfigs(ctx, "dev")
		if err != nil {
			return false
		}
		unlock()
		return true
	}
	if !free() {
		t.Fatal("the profile's config lock is held during the authorization")
	}
	// A toggle of the same profile is writing: the program's save waits.
	toggle, err := s.lockConfigs(context.Background(), "dev")
	if err != nil {
		t.Fatal(err)
	}
	flow.lines <- `{"event":"config_lock"}`
	time.Sleep(100 * time.Millisecond)
	if got := flow.deliveries(); len(got) != 0 {
		t.Fatalf("lock granted while another writer holds it: %v", got)
	}
	toggle()
	waitFor(t, func() bool {
		got := flow.deliveries()
		return len(got) == 1 && got[0] == `{"configLock":"held"}`
	})
	// Granted: the next writer of that profile waits for the verdict; another
	// profile's writers do not.
	if free() {
		t.Fatal("the profile's config lock is free while the program saves")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	other, err := s.lockConfigs(ctx, "ops")
	cancel()
	if err != nil {
		t.Fatalf("another profile's lock is blocked: %v", err)
	}
	other()
	flow.lines <- `{"event":"approved","tools":["search"]}`
	waitFor(t, free)
	flow.finish(nil)
}

// A program whose session was cancelled is never granted the lock: its save
// does not happen.
func TestMCPOAuthCancelledSessionIsNotGrantedTheConfigLock(t *testing.T) {
	flow := &lockingFlow{fakeFlow: newFakeFlow()}
	s := &Server{
		Probe: (&probeRecorder{}).probe(),
		StartMCPOAuth: func(context.Context, string, string, string) (OAuthFlow, error) {
			flow.lines <- `{"event":"authorization_url","url":"https://mcp.notion.com/authorize?state=a"}`
			return flow, nil
		},
	}
	srv := serve(t, s)
	_, out := call(t, srv, "POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb","profile":"dev"}`)
	id := out["sessionId"].(string)
	s.mu.Lock()
	s.mcpSessions[id].status = StatusCancelled
	s.mu.Unlock()
	flow.lines <- `{"event":"config_lock"}`
	time.Sleep(100 * time.Millisecond)
	if got := flow.deliveries(); len(got) != 0 {
		t.Fatalf("a cancelled session was granted the lock: %v", got)
	}
	flow.finish(nil)
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

// startedOAuth serves a host with one pending authorization for `profile`
// (URL state "s1"), and returns its session id.
func startedOAuth(t *testing.T, marker string) (*Server, *lockingFlow, func(string, string, string) (int, map[string]any), string) {
	t.Helper()
	flow := &lockingFlow{fakeFlow: newFakeFlow()}
	s := &Server{
		Probe:         (&probeRecorder{}).probe(),
		RestartMarker: marker,
		StartMCPOAuth: func(context.Context, string, string, string) (OAuthFlow, error) {
			flow.lines <- `{"event":"authorization_url","url":"https://mcp.notion.com/authorize?state=s1"}`
			return flow, nil
		},
	}
	srv := serve(t, s)
	do := func(method, path, body string) (int, map[string]any) { return call(t, srv, method, path, body) }
	_, out := do("POST", "/mcp/servers/notion/oauth", `{"redirectUri":"https://openedbot.example/cb","profile":"dev"}`)
	if out["callbackReceived"] != false {
		t.Fatalf("a fresh session claims a callback: %v", out)
	}
	return s, flow, do, out["sessionId"].(string)
}

// An error callback is held to the pending state like a code: without it,
// anyone knowing the callback URL could fail someone's authorization.
func TestMCPOAuthErrorCallbackMustCarryThePendingState(t *testing.T) {
	_, flow, do, _ := startedOAuth(t, "")
	for _, body := range []string{`{"error":"access_denied"}`, `{"error":"access_denied","state":"forged"}`} {
		if st, out := do("POST", "/mcp/servers/notion/oauth/callback", body); st != 400 || errorCode(out) != "OAUTH_CALLBACK_INVALID" {
			t.Fatalf("%s: %d %v", body, st, out)
		}
	}
	if got := flow.deliveries(); len(got) != 0 {
		t.Fatalf("an unauthenticated error reached the program: %v", got)
	}
	// The provider's real denial carries the state: relayed, the program fails it.
	if st, out := do("POST", "/mcp/servers/notion/oauth/callback", `{"error":"access_denied","state":"s1"}`); st != 200 || out["callbackReceived"] != false {
		t.Fatalf("%d %v", st, out)
	}
	if got := flow.deliveries(); len(got) != 1 || got[0] != `{"code":"","error":"access_denied","state":"s1"}` {
		t.Fatalf("%v", got)
	}
	flow.finish(nil)
}

// Once the provider's code reached the program, closing a page must not undo
// the approval: the cancel is refused, until a new attempt's URL says the
// callback did not complete.
func TestMCPOAuthCancelIsRefusedOnceTheCallbackIsReceived(t *testing.T) {
	_, flow, do, id := startedOAuth(t, "")
	if st, out := do("POST", "/mcp/servers/notion/oauth/callback", `{"code":"c","state":"s1"}`); st != 200 || out["callbackReceived"] != true || out["status"] != StatusPending {
		t.Fatalf("%d %v", st, out)
	}
	if st, out := do("DELETE", "/mcp/servers/notion/oauth/"+id, ""); st != 409 || errorCode(out) != "OAUTH_CALLBACK_RECEIVED" {
		t.Fatalf("%d %v", st, out)
	}
	if _, v := do("GET", "/mcp/servers/notion/oauth/"+id, ""); v["status"] != StatusPending || v["callbackReceived"] != true {
		t.Fatalf("%v", v)
	}
	// The exchange failed upstream and a new attempt began: cancellable again.
	flow.lines <- `{"event":"authorization_url","url":"https://mcp.notion.com/authorize?state=s2"}`
	waitFor(t, func() bool {
		_, v := do("GET", "/mcp/servers/notion/oauth/"+id, "")
		return v["callbackReceived"] == false
	})
	if st, _ := do("DELETE", "/mcp/servers/notion/oauth/"+id, ""); st != 204 {
		t.Fatalf("cancel after a new attempt %d", st)
	}
}

// A program granted the lock that never reports takes it back after the
// bound: the profile's other writers are not blocked, the session fails with
// its own code, and a late save is never reported as a success, though the
// disk changed (cache dropped, restart marker set).
func TestMCPOAuthConfigLockHeldTooLongIsTakenBack(t *testing.T) {
	previous := mcpOAuthConfigLockHold
	mcpOAuthConfigLockHold = 100 * time.Millisecond
	defer func() { mcpOAuthConfigLockHold = previous }()
	marker := filepath.Join(t.TempDir(), "pending")
	s, flow, do, id := startedOAuth(t, marker)
	do("POST", "/mcp/servers/notion/oauth/callback", `{"code":"c","state":"s1"}`)
	flow.lines <- `{"event":"config_lock"}`
	waitFor(t, func() bool { return len(flow.deliveries()) == 2 })
	waitFor(t, func() bool {
		_, v := do("GET", "/mcp/servers/notion/oauth/"+id, "")
		return v["status"] == StatusFailed && v["errorCode"] == "OAUTH_SAVE_TIMEOUT"
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	unlock, err := s.lockConfigs(ctx, "dev")
	if err != nil {
		t.Fatalf("the lock was not taken back: %v", err)
	}
	unlock()
	// The program was stopped; had it saved anyway, its verdict changes nothing.
	s.mu.Lock()
	sess := s.mcpSessions[id]
	s.mu.Unlock()
	late := newFakeFlow()
	late.lines <- `{"event":"approved","tools":["search"]}`
	late.finish(nil)
	s.mu.Lock()
	sess.flow = late
	s.mu.Unlock()
	go s.followMCPOAuth(context.Background(), sess)
	waitFor(t, func() bool { _, err := os.Stat(marker); return err == nil })
	if _, v := do("GET", "/mcp/servers/notion/oauth/"+id, ""); v["status"] != StatusFailed || v["errorCode"] != "OAUTH_SAVE_TIMEOUT" {
		t.Fatalf("a save without the lock reported as %v", v)
	}
}

// Granted, then the session was given up (expired, cancelled): the program
// still saved. `approved` is the truth on disk: connected, cache dropped,
// restart marker set, never left « cancelled ».
func TestMCPOAuthApprovedAfterTheSessionWasGivenUpIsReported(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "pending")
	s, flow, do, id := startedOAuth(t, marker)
	do("POST", "/mcp/servers/notion/oauth/callback", `{"code":"c","state":"s1"}`)
	flow.lines <- `{"event":"config_lock"}`
	waitFor(t, func() bool { return len(flow.deliveries()) == 2 })
	s.mu.Lock()
	s.mcpSessions[id].status = StatusCancelled
	s.mu.Unlock()
	flow.lines <- `{"event":"approved","tools":["search"]}`
	waitFor(t, func() bool {
		_, v := do("GET", "/mcp/servers/notion/oauth/"+id, "")
		return v["status"] == StatusConnected
	})
	waitFor(t, func() bool { _, err := os.Stat(marker); return err == nil })
	flow.finish(nil)
}
