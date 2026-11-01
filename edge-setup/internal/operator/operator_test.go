package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

const catalogueOK = `{"providers":[{"slug":"anthropic","authenticated":true},{"slug":"openai-codex","authenticated":false}]}`

type fakeLogin struct {
	lines chan string
	done  chan struct{}
	err   error
	kills int
}

func newFakeLogin() *fakeLogin {
	return &fakeLogin{lines: make(chan string, 16), done: make(chan struct{})}
}
func (f *fakeLogin) Lines() <-chan string { return f.lines }
func (f *fakeLogin) Wait() error          { <-f.done; return f.err }
func (f *fakeLogin) Kill()                { f.kills++; f.finish(errors.New("killed")) }
func (f *fakeLogin) finish(err error) {
	select {
	case <-f.done:
		return
	default:
	}
	f.err = err
	close(f.lines)
	close(f.done)
}

func newServer(t *testing.T, catalogue string, cli ...exec.Result) (*Server, *exectest.Fake, *httptest.Server) {
	t.Helper()
	fake := exectest.NewFake()
	result := exec.Result{}
	if len(cli) > 0 {
		result = cli[0]
	}
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", result)
	s := &Server{
		Runner: fake,
		Catalogue: func(context.Context) ([]byte, error) {
			if catalogue == "" {
				return nil, errors.New("gateway down")
			}
			return []byte(catalogue), nil
		},
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return s, fake, srv
}

func call(t *testing.T, srv *httptest.Server, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestAddCredentialKeyOnStdinOnlyAndProvenOnCatalogue(t *testing.T) {
	_, fake, srv := newServer(t, catalogueOK)
	status, out := call(t, srv, "POST", "/providers/anthropic/credentials", `{"apiKey":"sk-secret-123","label":"ohb-test"}`)
	if status != 200 || out["verification"] != "confirmed" || out["label"] != "ohb-test" {
		t.Fatalf("%d %v", status, out)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("calls: %v", fake.Commands())
	}
	c := fake.Calls[0]
	if strings.Contains(c.String(), "sk-secret") {
		t.Fatalf("the key reached argv: %s", c)
	}
	if string(c.Stdin) != "sk-secret-123\n" {
		t.Fatalf("stdin %q", c.Stdin)
	}
	for _, want := range []string{"/usr/sbin/runuser -u hermes", "hermes auth add anthropic --type api-key --label ohb-test"} {
		if !strings.Contains(c.String(), want) {
			t.Fatalf("argv %s lacks %q", c, want)
		}
	}
}

func TestAddCredentialVerdicts(t *testing.T) {
	_, _, srv := newServer(t, catalogueOK)
	status, out := call(t, srv, "POST", "/providers/openai-codex/credentials", `{"apiKey":"k"}`)
	if status != 200 || out["verification"] != "denied" || !strings.HasPrefix(out["label"].(string), "ohb-") {
		t.Fatalf("%d %v", status, out)
	}
	status, out = call(t, srv, "POST", "/providers/absent/credentials", `{"apiKey":"k"}`)
	if status != 200 || out["verification"] != "denied" || !strings.Contains(out["detail"].(string), "does not appear") {
		t.Fatalf("%d %v", status, out)
	}
	_, _, down := newServer(t, "")
	status, out = call(t, down, "POST", "/providers/anthropic/credentials", `{"apiKey":"k"}`)
	if status != 200 || out["verification"] != "unverified" {
		t.Fatalf("%d %v", status, out)
	}
}

func TestAddCredentialRefusesBadInput(t *testing.T) {
	_, fake, srv := newServer(t, catalogueOK)
	for _, c := range []struct{ path, body string }{
		{"/providers/Bad_Slug/credentials", `{"apiKey":"k"}`},
		{"/providers/anthropic/credentials", `{"apiKey":""}`},
		{"/providers/anthropic/credentials", "{\"apiKey\":\"a\\nb\"}"},
		{"/providers/anthropic/credentials", `{"apiKey":"k","label":"../x"}`},
		{"/providers/anthropic/credentials", `not json`},
		{"/providers/anthropic/credentials", `{"apiKey":"` + strings.Repeat("x", MaxAPIKey+1) + `"}`},
	} {
		status, _ := call(t, srv, "POST", c.path, c.body)
		if status != 400 {
			t.Errorf("%s %s: HTTP %d", c.path, c.body[:min(20, len(c.body))], status)
		}
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("the CLI ran on refused input: %v", fake.Commands())
	}
	if status, _ := call(t, srv, "GET", "/providers/anthropic/credentials", ""); status != 405 && status != 404 {
		t.Fatalf("GET credentials: %d", status)
	}
	if status, _ := call(t, srv, "POST", "/exec", `{}`); status != 404 {
		t.Fatalf("unknown route: %d", status)
	}
}

func TestAddCredentialRedactsTheKeyFromCLIErrors(t *testing.T) {
	_, _, srv := newServer(t, catalogueOK, exec.Result{ExitCode: 1, Stderr: "bad key sk-leak-999 rejected"})
	status, out := call(t, srv, "POST", "/providers/anthropic/credentials", `{"apiKey":"sk-leak-999"}`)
	msg := out["error"].(map[string]any)["message"].(string)
	if status != 502 || strings.Contains(msg, "sk-leak") || !strings.Contains(msg, "[redacted]") {
		t.Fatalf("%d %q", status, msg)
	}
}

const codexOutput = "To continue, follow these steps:\n\n  1. Open this URL in your browser:\n     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n  2. Enter this code:\n     \x1b[94mABCD-EFGH\x1b[0m\n\nWaiting for sign-in... (press Ctrl+C to cancel)\n"

func TestOAuthSessionLifecycle(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	s, _, srv := newServer(t, `{"providers":[{"slug":"openai-codex","authenticated":true}]}`)
	s.Now = func() time.Time { return now }
	login := newFakeLogin()
	var started []string
	s.StartLogin = func(_ context.Context, p string) (Login, error) { started = append(started, p); return login, nil }

	status, out := call(t, srv, "POST", "/providers/openai-codex/oauth", `{}`)
	if status != 200 || out["status"] != StatusStarting || out["verificationUri"] != nil {
		t.Fatalf("%d %v", status, out)
	}
	id := out["sessionId"].(string)
	if started[0] != "openai-codex" || out["expiresAt"] != "2026-09-02T12:15:00Z" {
		t.Fatalf("%v %v", started, out["expiresAt"])
	}
	// A second start for the same provider returns the pending one.
	if st, dup := call(t, srv, "POST", "/providers/openai-codex/oauth", `{}`); st != 409 || dup["session"].(map[string]any)["sessionId"] != id {
		t.Fatalf("%d %v", st, dup)
	}
	for _, l := range strings.Split(codexOutput, "\n") {
		login.lines <- l
	}
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, "")
		return v["status"] == StatusPending
	})
	_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, "")
	if v["verificationUri"] != "https://auth.openai.com/codex/device" || v["userCode"] != "ABCD-EFGH" {
		t.Fatalf("%v", v)
	}
	if st, _ := call(t, srv, "GET", "/providers/anthropic/oauth/"+id, ""); st != 404 {
		t.Fatalf("cross-provider read: %d", st)
	}
	login.finish(nil)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, "")
		return v["status"] == StatusConnected
	})
	// Terminal sessions stay readable, then vanish 15 min after expiry.
	now = now.Add(31 * time.Minute)
	if st, _ := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, ""); st != 404 {
		t.Fatalf("expired session still served: %d", st)
	}
}

func TestOAuthFailedWhenCLIExitsWithoutProof(t *testing.T) {
	s, _, srv := newServer(t, `{"providers":[{"slug":"openai-codex","authenticated":false}]}`)
	login := newFakeLogin()
	s.StartLogin = func(context.Context, string) (Login, error) { return login, nil }
	_, out := call(t, srv, "POST", "/providers/openai-codex/oauth", ``)
	id := out["sessionId"].(string)
	login.lines <- "Login timed out after 15 minutes."
	login.finish(errors.New("exit status 1"))
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, "")
		return v["status"] == StatusFailed
	})
	_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, "")
	if !strings.Contains(v["error"].(string), "Login timed out") {
		t.Fatalf("%v", v)
	}
	// CLI exit 0 but the catalogue does not confirm: still failed.
	login2 := newFakeLogin()
	s.StartLogin = func(context.Context, string) (Login, error) { return login2, nil }
	_, out = call(t, srv, "POST", "/providers/openai-codex/oauth", ``)
	id2 := out["sessionId"].(string)
	login2.finish(nil)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id2, "")
		return v["status"] == StatusFailed
	})
}

func TestOAuthCancelKillsTheLogin(t *testing.T) {
	s, _, srv := newServer(t, catalogueOK)
	login := newFakeLogin()
	s.StartLogin = func(context.Context, string) (Login, error) { return login, nil }
	_, out := call(t, srv, "POST", "/providers/openai-codex/oauth", ``)
	id := out["sessionId"].(string)
	if st, _ := call(t, srv, "DELETE", "/providers/openai-codex/oauth/"+id, ""); st != 204 {
		t.Fatalf("cancel: %d", st)
	}
	_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, "")
	if v["status"] != StatusCancelled || login.kills != 1 {
		t.Fatalf("%v kills=%d", v, login.kills)
	}
	if st, _ := call(t, srv, "DELETE", "/providers/openai-codex/oauth/nope", ""); st != 404 {
		t.Fatalf("unknown cancel: %d", st)
	}
}

func TestOAuthExpiryKillsAPendingLogin(t *testing.T) {
	now := time.Now()
	s, _, srv := newServer(t, catalogueOK)
	s.Now = func() time.Time { return now }
	login := newFakeLogin()
	s.StartLogin = func(context.Context, string) (Login, error) { return login, nil }
	_, out := call(t, srv, "POST", "/providers/openai-codex/oauth", ``)
	id := out["sessionId"].(string)
	now = now.Add(SessionTTL + time.Second)
	_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, "")
	if v["status"] != StatusFailed || login.kills != 1 {
		t.Fatalf("%v kills=%d", v, login.kills)
	}
}

func TestParseVariants(t *testing.T) {
	cases := map[string][2]string{
		codexOutput: {"https://auth.openai.com/codex/device", "ABCD-EFGH"},
		"Open https://portal.nousresearch.com/device?x=1 and enter code: WXYZ-1234\n":              {"https://portal.nousresearch.com/device?x=1", "WXYZ-1234"},
		"  1. Visit https://x.ai/oauth/device\n  2. If prompted, enter code: K7M2P9QZ\nWaiting…\n": {"https://x.ai/oauth/device", "K7M2P9QZ"},
	}
	for in, want := range cases {
		var p loginParser
		for _, l := range strings.Split(in, "\n") {
			p.feed(l)
		}
		if p.uri != want[0] || p.code != want[1] {
			t.Errorf("%q: uri=%q code=%q", in, p.uri, p.code)
		}
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met")
}

func TestCapabilities(t *testing.T) {
	_, _, srv := newServer(t, catalogueOK)
	status, out := call(t, srv, "GET", "/capabilities", "")
	features, ok := out["features"].([]any)
	if status != 200 || !ok || len(features) != 2 || features[0] != "provider_management" || features[1] != "provider_usage" {
		t.Fatalf("%d %v", status, out)
	}
}

func TestProviderUsageRunsOnlyTheEmbeddedFixedProbe(t *testing.T) {
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{Stdout: `{"fetchedAt":"2026-09-02T09:41:12Z","providers":[{"provider":"anthropic","usage":{"plan":"max","seven_day":{"utilization":97,"resets_at":"2026-09-04T00:00:00+00:00"}}},{"provider":"openrouter","usage":{"total_credits":50,"total_usage":3}}]}`})
	s := &Server{
		Runner: fake,
		Catalogue: func(context.Context) ([]byte, error) {
			return []byte(`{"providers":[{"slug":"anthropic","authenticated":true},{"slug":"openai-codex","authenticated":false},{"slug":"openrouter","authenticated":true},{"slug":"xai","authenticated":true}]}`), nil
		},
		UsageProbe: HostUsageProbe(fake),
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	status, out := call(t, srv, "GET", "/usage", "")
	if status != 200 || out["fetchedAt"] != "2026-09-02T09:41:12Z" {
		t.Fatalf("%d %v", status, out)
	}
	providers := out["providers"].([]any)
	if len(providers) != 3 {
		t.Fatalf("providers %v", providers)
	}
	anthropic := providers[0].(map[string]any)
	if anthropic["source"] != "oauth_usage_api" || anthropic["plan"] != "max" || anthropic["windows"].([]any)[0].(map[string]any)["usedPercent"] != float64(97) {
		t.Fatalf("anthropic %v", anthropic)
	}
	openrouter := providers[1].(map[string]any)
	if openrouter["source"] != "credits_api" || len(openrouter["details"].([]any)) != 2 {
		t.Fatalf("openrouter %v", openrouter)
	}
	xai := providers[2].(map[string]any)
	if xai["source"] != "unsupported" || xai["unavailableReason"] != "no account-usage endpoint for this provider" {
		t.Fatalf("xai %v", xai)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("calls %v", fake.Commands())
	}
	cmd := fake.Calls[0]
	if !strings.Contains(cmd.String(), "/usr/local/lib/hermes-agent/venv/bin/python - anthropic openrouter") || strings.Contains(cmd.String(), "sh ") || strings.Contains(cmd.String(), "sk-") {
		t.Fatalf("unsafe usage argv %q", cmd.String())
	}
	if !bytes.Equal(cmd.Stdin, usageProbeScript) || !bytes.Contains(cmd.Stdin, []byte("fetch_account_usage")) || bytes.Contains(cmd.Stdin, []byte("str(exc)")) {
		t.Fatal("the immutable probe source was not the bounded embedded script")
	}
}

func TestProviderUsageMapsProbeFailuresAndNormalisesBounds(t *testing.T) {
	valid := []byte(`{"fetchedAt":"bad","providers":[{"provider":"anthropic","usage":{"windows":[{"label":"` + strings.Repeat("x", 70) + `","used_percent":150,"reset_at":"bad","detail":"` + strings.Repeat("d", 210) + `"}]}}]}`)
	for name, testCase := range map[string]struct {
		probe UsageProbe
		want  int
	}{
		"timeout":      {func(context.Context, []string) ([]byte, error) { return nil, context.DeadlineExceeded }, http.StatusGatewayTimeout},
		"failure":      {func(context.Context, []string) ([]byte, error) { return nil, errors.New("upstream secret") }, http.StatusBadGateway},
		"too large":    {func(context.Context, []string) ([]byte, error) { return make([]byte, maxUsageOutput+1), nil }, http.StatusBadGateway},
		"invalid JSON": {func(context.Context, []string) ([]byte, error) { return []byte("not-json"), nil }, http.StatusBadGateway},
		"normalised":   {func(context.Context, []string) ([]byte, error) { return valid, nil }, http.StatusOK},
	} {
		t.Run(name, func(t *testing.T) {
			s := &Server{Catalogue: func(context.Context) ([]byte, error) {
				return []byte(`{"providers":[{"slug":"anthropic","authenticated":true}]}`), nil
			}, UsageProbe: testCase.probe}
			srv := httptest.NewServer(s.Handler())
			defer srv.Close()
			status, out := call(t, srv, "GET", "/usage", "")
			if status != testCase.want {
				t.Fatalf("%d %v", status, out)
			}
			if status == http.StatusBadGateway {
				message := out["error"].(map[string]any)["message"].(string)
				if strings.Contains(message, "secret") {
					t.Fatalf("probe error leaked: %q", message)
				}
			}
			if status == http.StatusOK {
				item := out["providers"].([]any)[0].(map[string]any)
				window := item["windows"].([]any)[0].(map[string]any)
				if len(window["label"].(string)) != 64 || window["usedPercent"] != float64(100) || window["resetAt"] != nil || window["detail"] != nil {
					t.Fatalf("window not bounded: %v", window)
				}
			}
		})
	}
}

func TestProviderUsageNeverReturnsUpstreamDiagnosticText(t *testing.T) {
	document, err := normaliseUsageProbe(
		[]byte(`{"fetchedAt":"2026-09-02T09:41:12Z","providers":[{"provider":"anthropic","unavailableReason":"upstream bearer=secret-value"}]}`),
		[]string{"anthropic"},
		time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "secret-value") {
		t.Fatalf("upstream diagnostic leaked: %s", encoded)
	}
	if got := *document.Providers[0].UnavailableReason; got != "account usage is unavailable" {
		t.Fatalf("unavailable reason %q", got)
	}
	windowDocument, err := normaliseUsageProbe(
		[]byte(`{"fetchedAt":"2026-09-02T09:41:12Z","providers":[{"provider":"anthropic","usage":{"details":["HTTP secret-value"],"windows":[{"used_percent":10,"description":"secret-value"}]}}]}`),
		[]string{"anthropic"},
		time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err = json.Marshal(windowDocument)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "secret-value") {
		t.Fatalf("upstream detail leaked: %s", encoded)
	}
}

func TestProviderUsageCachesAndSingleFlights(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var calls atomic.Int32
	s := &Server{
		Catalogue: func(context.Context) ([]byte, error) {
			return []byte(`{"providers":[{"slug":"anthropic","authenticated":true}]}`), nil
		},
		UsageProbe: func(context.Context, []string) ([]byte, error) {
			calls.Add(1)
			once.Do(func() { close(started) })
			<-release
			return []byte(`{"fetchedAt":"2026-09-02T09:41:12Z","providers":[{"provider":"anthropic","usage":{"windows":[]}}]}`), nil
		},
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	statuses := make(chan int, 5)
	for i := 0; i < cap(statuses); i++ {
		go func() {
			resp, err := http.Get(srv.URL + "/usage")
			if err != nil {
				statuses <- 0
				return
			}
			resp.Body.Close()
			statuses <- resp.StatusCode
		}()
	}
	<-started
	close(release)
	for i := 0; i < cap(statuses); i++ {
		if status := <-statuses; status != http.StatusOK {
			t.Fatalf("concurrent status %d", status)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("probe runs=%d", calls.Load())
	}
	if status, _ := call(t, srv, "GET", "/usage", ""); status != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("cache missed: status=%d runs=%d", status, calls.Load())
	}
}

func TestProviderUsageNoCacheBypassesTheMinuteCache(t *testing.T) {
	var calls atomic.Int32
	s := &Server{
		Catalogue: func(context.Context) ([]byte, error) {
			return []byte(`{"providers":[{"slug":"openai-codex","authenticated":true}]}`), nil
		},
		UsageProbe: func(context.Context, []string) ([]byte, error) {
			calls.Add(1)
			return []byte(`{"fetchedAt":"2026-09-05T06:51:06Z","providers":[{"provider":"openai-codex","usage":{"plan":"Prolite","windows":[{"label":"Session","used_percent":100,"reset_at":"2026-09-11T10:06:25+00:00"}],"details":["Credits balance: $12.50","You have 2 resets banked - use /usage reset to activate","HTTP bearer=secret-value"]}}]}`), nil
		},
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	if status, _ := call(t, srv, "GET", "/usage", ""); status != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("first read: status=%d runs=%d", status, calls.Load())
	}
	if status, _ := call(t, srv, "GET", "/usage", ""); status != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("cached read: status=%d runs=%d", status, calls.Load())
	}
	req, _ := http.NewRequest("GET", srv.URL+"/usage", nil)
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("forced read: status=%d runs=%d", resp.StatusCode, calls.Load())
	}
	codex := out["providers"].([]any)[0].(map[string]any)
	details := codex["details"].([]any)
	if len(details) != 2 || details[0] != "Credits balance: $12.50" || details[1] != "You have 2 resets banked - use /usage reset to activate" {
		t.Fatalf("details %v", details)
	}
	if encoded, _ := json.Marshal(out); strings.Contains(string(encoded), "secret-value") {
		t.Fatalf("upstream diagnostic leaked: %s", encoded)
	}
}

const codexPoolListing = "openai-codex (3 credentials):\n  #1  openai-codex-oauth-1 oauth   device_code \u2190\n  #2  openai-codex-oauth-2 oauth   device_code rate-limited usage_limit_reached (429) (5d 19h left)\n  #3  openai-codex-oauth-3 oauth   device_code\n\nanthropic (1 credentials):\n  #1  anthropic-oauth-1 oauth   device_code\n"

func TestPoolLabelsReadsOneProviderInOrder(t *testing.T) {
	got := poolLabels(codexPoolListing, "openai-codex")
	if strings.Join(got, ",") != "openai-codex-oauth-1,openai-codex-oauth-2,openai-codex-oauth-3" {
		t.Fatalf("labels %v", got)
	}
	if got := poolLabels(codexPoolListing, "anthropic"); len(got) != 1 || got[0] != "anthropic-oauth-1" {
		t.Fatalf("anthropic labels %v", got)
	}
	if got := poolLabels(codexPoolListing, "gemini"); got != nil {
		t.Fatalf("unknown provider labels %v", got)
	}
}

func TestOAuthConnectedRemovesTheReplacedLogins(t *testing.T) {
	s, fake, srv := newServer(t, `{"providers":[{"slug":"openai-codex","authenticated":true}]}`)
	fake.On(hermes.CLI("auth", "list").String(), exec.Result{Stdout: codexPoolListing})
	login := newFakeLogin()
	s.StartLogin = func(context.Context, string) (Login, error) { return login, nil }
	_, out := call(t, srv, "POST", "/providers/openai-codex/oauth", `{}`)
	id := out["sessionId"].(string)
	login.finish(nil)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/providers/openai-codex/oauth/"+id, "")
		return v["status"] == StatusConnected
	})
	var removed []string
	for _, c := range fake.Calls {
		if i := strings.Index(c.String(), " auth remove "); i >= 0 {
			removed = append(removed, strings.TrimPrefix(c.String()[i:], " auth remove "))
		}
	}
	if strings.Join(removed, ";") != "openai-codex openai-codex-oauth-1;openai-codex openai-codex-oauth-2" {
		t.Fatalf("removed %v", removed)
	}
}

func TestSocketOwnershipFallsBackToRootOnly(t *testing.T) {
	if gid, mode := SocketOwnership(0, errors.New("unknown group")); gid != 0 || mode != 0o600 {
		t.Fatalf("%d %o", gid, mode)
	}
	if gid, mode := SocketOwnership(997, nil); gid != 997 || mode != 0o660 {
		t.Fatalf("%d %o", gid, mode)
	}
}

// The link allows 64 requests in flight. `hermes auth add` runs a CLI for up
// to two minutes under the service user, so a second concurrent add is
// refused rather than forking another process on a small host.
func TestAddCredentialIsSingleFlight(t *testing.T) {
	fake := exectest.NewFake()
	entered := make(chan struct{})
	release := make(chan struct{})
	blocking := &blockingRunner{Fake: fake, entered: entered, release: release}
	s := &Server{
		Runner:    blocking,
		Catalogue: func(context.Context) ([]byte, error) { return []byte(catalogueOK), nil },
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	first := make(chan int, 1)
	go func() {
		status, _ := call(t, srv, "POST", "/providers/anthropic/credentials", `{"apiKey":"sk-a"}`)
		first <- status
	}()
	<-entered
	status, out := call(t, srv, "POST", "/providers/openrouter/credentials", `{"apiKey":"sk-b"}`)
	if status != http.StatusConflict {
		t.Fatalf("second add: status=%d out=%v", status, out)
	}
	close(release)
	if got := <-first; got != 200 {
		t.Fatalf("first add: status=%d", got)
	}
	// Once the first one finished, the next add is accepted again.
	if status, _ := call(t, srv, "POST", "/providers/openrouter/credentials", `{"apiKey":"sk-c"}`); status != 200 {
		t.Fatalf("third add after release: status=%d", status)
	}
}

// blockingRunner holds the first command until release is closed.
type blockingRunner struct {
	*exectest.Fake
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *blockingRunner) Run(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	blocked := false
	b.once.Do(func() { blocked = true })
	if blocked {
		close(b.entered)
		select {
		case <-b.release:
		case <-ctx.Done():
			return exec.Result{}, ctx.Err()
		}
	}
	return exec.Result{}, nil
}
