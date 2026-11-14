package gateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func fakeGateway(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			w.WriteHeader(200)
		case "/v1/toolsets":
			if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
				w.WriteHeader(401)
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"name":"web","enabled":true},{"name":"terminal","enabled":true},{"name":"file","enabled":true},{"name":"code_execution","enabled":true},{"name":"vision","enabled":true},{"name":"image_gen","enabled":true},{"name":"bfl","enabled":true},{"name":"todo","enabled":true},{"name":"browser","enabled":false}]}`))
		case "/api/model/options":
			_, _ = w.Write([]byte(`{"providers":[{"slug":"anthropic","authenticated":true},{"slug":"openai","authenticated":false}]}`))
		case "/api/sessions":
			if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
				w.WriteHeader(401)
				return
			}
			q := r.URL.Query()
			if q.Get("limit") != "100" || q.Get("archived") != "include" || q.Get("order") != "created" {
				w.WriteHeader(400)
				return
			}
			_, _ = w.Write([]byte(`{"sessions":[{"id":"s-` + q.Get("profile") + `-` + q.Get("offset") + `","started_at":1}],"total":1}`))
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestProofs(t *testing.T) {
	srv := fakeGateway(t)
	defer srv.Close()
	c := Client{BaseURL: srv.URL, Token: strings.Repeat("a", 64), HTTP: srv.Client()}
	ctx := context.Background()
	if st, err := c.Health(ctx); err != nil || st != 200 {
		t.Fatalf("health %d %v", st, err)
	}
	if err := c.RequireUnauthorizedWithoutBearer(ctx); err != nil {
		t.Fatal(err)
	}
	names, err := c.Toolsets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := RequireToolsetPolicy(names); err != nil {
		t.Fatal(err)
	}
	body, err := c.ModelOptions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for slug, want := range map[string]ProviderVerdict{"anthropic": Authenticated, "openai": Denied, "mistral": Absent} {
		if got, _ := ProviderState(body, slug); got != want {
			t.Errorf("%s: %s", slug, got)
		}
	}
}

func TestToolsetPolicy(t *testing.T) {
	// A toolset outside the install-time baseline is the owner's business:
	// enabling `browser` from the console or through the link must not read
	// as drift, because nothing forbids it.
	extra, err := EnabledToolsets([]byte(`{"data":[{"name":"web","enabled":true},{"name":"browser","enabled":true}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := RequireToolsetPolicy(extra); err != nil {
		t.Fatalf("a toolset the owner enabled is not drift: %v", err)
	}
	// A forbidden toolset is refused whoever enabled it, and named.
	forbidden, err := EnabledToolsets([]byte(`{"data":[{"name":"web","enabled":true},{"name":"memory","enabled":true},{"name":"cronjob","enabled":true},{"name":"delegation","enabled":false}]}`))
	if err != nil {
		t.Fatal(err)
	}
	err = RequireToolsetPolicy(forbidden)
	if err == nil {
		t.Fatal("an enabled forbidden toolset must be refused")
	}
	if !strings.Contains(err.Error(), "cronjob") || !strings.Contains(err.Error(), "memory") {
		t.Fatalf("the refusal must name every active forbidden toolset: %v", err)
	}
	if strings.Contains(err.Error(), "delegation") {
		t.Fatalf("a forbidden toolset that is disabled is not active: %v", err)
	}
	if _, err := EnabledToolsets([]byte(`{"items":[]}`)); err == nil {
		t.Fatal("payload without data array must be refused")
	}
}

func TestToolsetEnabled(t *testing.T) {
	body := []byte(`{"data":[{"name":"web","enabled":true},{"name":"browser","enabled":false}]}`)
	if on, err := ToolsetEnabled(body, "web"); err != nil || !on {
		t.Fatalf("web: %v %v", on, err)
	}
	// Disabled and absent both answer false: only an unreadable inventory
	// is an error, so a toggle that did not take effect reads as a refusal
	// and never as a transport failure.
	for _, name := range []string{"browser", "never_shipped"} {
		if on, err := ToolsetEnabled(body, name); err != nil || on {
			t.Fatalf("%s: %v %v", name, on, err)
		}
	}
	if _, err := ToolsetEnabled([]byte(`nope`), "web"); err == nil {
		t.Fatal("an unreadable inventory must be an error")
	}
}

func TestProfileToolsetInventoryUsesProfilePathAndBearer(t *testing.T) {
	const token = "profile-root-token"
	var got *http.Request
	c := Client{
		BaseURL: "http://gateway",
		Token:   token,
		HTTP: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			got = r
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{"data":[]}`)),
				Header:     make(http.Header),
				Request:    r,
			}, nil
		})},
	}
	if _, err := c.ProfileToolsetInventory(context.Background(), "scout"); err != nil {
		t.Fatal(err)
	}
	if got.URL.Path != "/p/scout/v1/toolsets" || got.Header.Get("Authorization") != "Bearer "+token {
		t.Fatalf("request path=%q authorization=%q", got.URL.Path, got.Header.Get("Authorization"))
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestValidToken(t *testing.T) {
	if !ValidToken(strings.Repeat("0f", 32)) || ValidToken("short") || ValidToken(strings.Repeat("g", 64)) {
		t.Fatal("token validation")
	}
}

func TestSessionsPageIsBearerScopedAndProfileAware(t *testing.T) {
	srv := fakeGateway(t)
	defer srv.Close()
	c := Client{BaseURL: srv.URL, Token: strings.Repeat("a", 64), HTTP: srv.Client()}
	body, err := c.Sessions(context.Background(), "scout", 200)
	if err != nil || !strings.Contains(string(body), `"id":"s-scout-200"`) {
		t.Fatalf("%s %v", body, err)
	}
	if body, err := c.Sessions(context.Background(), "", 0); err != nil || !strings.Contains(string(body), `"id":"s--0"`) {
		t.Fatalf("default profile: %s %v", body, err)
	}
	if _, err := (Client{BaseURL: srv.URL, Token: "wrong", HTTP: srv.Client()}).Sessions(context.Background(), "", 0); err == nil {
		t.Fatal("an unauthorised page must be an error")
	}
}
