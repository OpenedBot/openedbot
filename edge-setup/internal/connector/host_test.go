package connector

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeOperator is hermes-operator behind a Unix socket.
func fakeOperator(t *testing.T) (string, *[]string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "op")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "operator.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var seen []string
	var mu sync.Mutex
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+" ct="+r.Header.Get("Content-Type")+" auth="+r.Header.Get("Authorization")+" body="+string(body))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/capabilities":
			_, _ = w.Write([]byte(`{"features":["provider_management","provider_usage","toolset_management","mcp_management"]}`))
		case r.Method == "GET" && r.URL.Path == "/toolsets":
			_, _ = w.Write([]byte(`{"platform":"api_server","settable":["web","browser"]}`))
		case r.Method == "POST" && r.URL.Path == "/toolsets/browser":
			_, _ = w.Write([]byte(`{"name":"browser","platform":"api_server","enabled":true,"requested":true,"applied":true}`))
		case r.Method == "GET" && r.URL.Path == "/usage":
			_, _ = w.Write([]byte(`{"fetchedAt":"2026-09-02T09:41:12Z","providers":[]}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/credentials"):
			_, _ = w.Write([]byte(`{"provider":"anthropic","label":"openedbot-1","verification":"confirmed","detail":null}`))
		case r.Method == "DELETE":
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":"OAUTH_SESSION_NOT_FOUND","message":"gone"}}`))
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return socket, &seen
}

func startClient(t *testing.T, broker *fakeBroker, gwURL string, gwClient *http.Client, socket string) *Client {
	t.Helper()
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gwURL, bearer, nil)
	c.HTTP = gwClient
	c.OperatorSocket = socket
	if socket == "/nonexistent/operator.sock" {
		// The session reads the clock while watchOperator advances it.
		var mu sync.Mutex
		now := time.Now()
		c.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
		c.wait = func(ctx context.Context, d time.Duration) error {
			mu.Lock()
			defer mu.Unlock()
			now = now.Add(d)
			return context.DeadlineExceeded
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	return c
}

func TestHostRoutesGoToTheOperatorNeverToTheGateway(t *testing.T) {
	broker := newBroker(t)
	gw, gwSeen := fakeGateway(t)
	socket, opSeen := fakeOperator(t)
	startClient(t, broker, gw.URL, gw.Client(), socket)
	// hello repeats what the OPERATOR announced, not a list hard-coded here:
	// a host whose operator cannot serve the toolset verbs must not make
	// openedbot render a toggle whose write would fail.
	if got := broker.hello.Features; len(got) != 4 || got[2] != FeatureToolsetManagement || got[3] != FeatureMCPManagement {
		t.Fatalf("hello features %v", got)
	}
	broker.send(Text{T: TReq, ID: 1, Method: "POST", Path: "/p/prod-1/hermes-setup/providers/anthropic/credentials", Headers: map[string]string{"content-type": "application/json", "authorization": "Bearer attacker"}, Body: "stream"})
	broker.sendBinary(1, []byte(`{"apiKey":"sk-secret"}`))
	broker.send(Text{T: TEnd, ID: 1})
	if r := broker.next(t); r.T != TRes || r.Status != 200 || r.Headers["content-type"] != "application/json" {
		t.Fatalf("%+v", r)
	}
	if body := broker.body(t, 1); !strings.Contains(body, `"verification":"confirmed"`) {
		t.Fatalf("%q", body)
	}
	broker.send(Text{T: TReq, ID: 2, Method: "DELETE", Path: "/hermes-setup/providers/anthropic/oauth/s-1", Body: "none"})
	if r := broker.next(t); r.T != TRes || r.Status != 204 {
		t.Fatalf("%+v", r)
	}
	broker.body(t, 2)
	broker.send(Text{T: TReq, ID: 3, Method: "GET", Path: "/hermes-setup/usage", Body: "none"})
	if r := broker.next(t); r.T != TRes || r.Status != 200 {
		t.Fatalf("%+v", r)
	}
	if body := broker.body(t, 3); !strings.Contains(body, `"fetchedAt"`) {
		t.Fatalf("usage body %q", body)
	}
	broker.send(Text{T: TReq, ID: 4, Method: "POST", Path: "/hermes-setup/toolsets/browser", Headers: map[string]string{"content-type": "application/json"}, Body: "stream"})
	broker.sendBinary(4, []byte(`{"enabled":true}`))
	broker.send(Text{T: TEnd, ID: 4})
	if r := broker.next(t); r.T != TRes || r.Status != 200 {
		t.Fatalf("%+v", r)
	}
	if body := broker.body(t, 4); !strings.Contains(body, `"applied":true`) {
		t.Fatalf("toolset body %q", body)
	}
	// The first line is the capability read the client makes when the session
	// opens; the toolset write is a HOST route and never reaches the gateway.
	if len(*opSeen) != 5 || (*opSeen)[0] != "GET /capabilities ct= auth= body=" || !strings.HasPrefix((*opSeen)[1], "POST /providers/anthropic/credentials ct=application/json auth= body={\"apiKey\":\"sk-secret\"}") || (*opSeen)[2] != "DELETE /providers/anthropic/oauth/s-1 ct= auth= body=" || (*opSeen)[3] != "GET /usage ct= auth= body=" || (*opSeen)[4] != "POST /toolsets/browser ct=application/json auth= body={\"enabled\":true}" {
		t.Fatalf("operator saw %q", *opSeen)
	}
	for _, s := range *gwSeen {
		if strings.Contains(s, "hermes-setup") || strings.Contains(s, "providers") {
			t.Fatalf("a host route reached the gateway: %q", s)
		}
	}
	for _, f := range broker.sent {
		if strings.Contains(string(f), bearer) {
			t.Fatal("bearer leaked toward the broker")
		}
	}
}

func TestHostRoutesFailBeforeDispatchWithoutOperator(t *testing.T) {
	broker := newBroker(t)
	gw, gwSeen := fakeGateway(t)
	startClient(t, broker, gw.URL, gw.Client(), "/nonexistent/operator.sock")
	if len(broker.hello.Features) != 0 {
		t.Fatalf("hello announced %v without an operator", broker.hello.Features)
	}
	broker.send(Text{T: TReq, ID: 1, Method: "POST", Path: "/hermes-setup/providers/anthropic/oauth", Body: "none"})
	if e := broker.next(t); e.T != TErr || e.Code != "HERMES_OPERATOR_UNAVAILABLE" || e.Stage != StageBeforeDispatch {
		t.Fatalf("%+v", e)
	}
	// The gateway allowlist still refuses the same path family outright.
	broker.send(Text{T: TReq, ID: 2, Method: "GET", Path: "/hermes-setup/providers/anthropic/credentials", Body: "none"})
	if e := broker.next(t); e.T != TErr || e.Code != "HERMES_LINK_PATH_FORBIDDEN" {
		t.Fatalf("%+v", e)
	}
	if len(*gwSeen) != 0 {
		t.Fatalf("gateway saw %q", *gwSeen)
	}
}

func TestCapabilitiesCarryLinkFeatures(t *testing.T) {
	broker := newBroker(t)
	gw := fakeCapabilitiesGateway(t, `{"version":"0.22.2","features":{"run_steer":true},"endpoints":{}}`)
	socket, _ := fakeOperator(t)
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	j, _ := NewJournal(t.TempDir())
	c.Journal = j
	c.HTTP = gw.Client()
	c.OperatorSocket = socket
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/p/prod-1/v1/capabilities", Body: "none"})
	if r := broker.next(t); r.T != TRes || r.Status != 200 {
		t.Fatalf("%+v", r)
	}
	var doc struct {
		Version  string          `json:"version"`
		Features map[string]bool `json:"features"`
	}
	if err := json.Unmarshal([]byte(broker.body(t, 1)), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Version != "0.22.2" || !doc.Features["run_steer"] || !doc.Features["event_replay"] || !doc.Features["provider_management"] || !doc.Features["provider_usage"] {
		t.Fatalf("%+v", doc)
	}
}

func TestInjectFeatures(t *testing.T) {
	providers := []string{FeatureProviderManagement, FeatureProviderUsage}
	out := InjectFeatures([]byte(`{"features":{"x":1},"k":[1,2]}`), true, nil)
	if string(out) != `{"features":{"event_replay":true,"x":1},"k":[1,2]}` {
		t.Fatalf("%s", out)
	}
	out = InjectFeatures([]byte(`{"a":1}`), false, providers)
	if string(out) != `{"a":1,"features":{"provider_management":true,"provider_usage":true}}` {
		t.Fatalf("%s", out)
	}
	// A host that also serves the toolset and MCP verbs advertises them here,
	// so a client reading only /v1/capabilities sees the same surface hello
	// announced.
	out = InjectFeatures([]byte(`{"a":1}`), false, []string{FeatureToolsetManagement, FeatureMCPManagement})
	if string(out) != `{"a":1,"features":{"mcp_management":true,"toolset_management":true}}` {
		t.Fatalf("%s", out)
	}
	// A feature the operator stopped serving is CLEARED, never left standing
	// from an answer the gateway cached or an older tool wrote.
	out = InjectFeatures([]byte(`{"features":{"provider_management":true,"toolset_management":true,"x":1}}`), false, providers)
	if string(out) != `{"features":{"provider_management":true,"provider_usage":true,"x":1}}` {
		t.Fatalf("%s", out)
	}
	// A name that is not a feature name never reaches the document.
	out = InjectFeatures([]byte(`{"a":1}`), false, []string{"Not A Feature"})
	if string(out) != `{"a":1,"features":{}}` {
		t.Fatalf("%s", out)
	}
	if got := InjectFeatures([]byte(`not json`), true, providers); string(got) != "not json" {
		t.Fatalf("%s", got)
	}
	if got := InjectFeatures([]byte(`[1]`), true, providers); string(got) != "[1]" {
		t.Fatalf("%s", got)
	}
}

func fakeCapabilitiesGateway(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+bearer {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/p/prod-1/v1/capabilities" || r.URL.Path == "/v1/capabilities" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// A host route whose operator connection breaks after it was accepted may
// have been applied: only a refused or missing socket proves nothing was sent.
func TestHostRouteDispatchStageFollowsWhatTheFailureProves(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "op")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T, socket string)
		want  string
	}{
		{"connection closed before the answer", func(t *testing.T, socket string) {
			ln, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { ln.Close() })
			go func() {
				for {
					conn, err := ln.Accept()
					if err != nil {
						return
					}
					// Read the request, as an operator that applies it would, then drop it.
					_, _ = conn.Read(make([]byte, 4096))
					conn.Close()
				}
			}()
		}, StageAfterDispatch},
		{"refused connection", func(t *testing.T, socket string) {
			ln, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			ln.(*net.UnixListener).SetUnlinkOnClose(false)
			ln.Close()
		}, StageBeforeDispatch},
	} {
		t.Run(tc.name, func(t *testing.T) {
			socket := filepath.Join(dir, strings.ReplaceAll(tc.name, " ", "-")[:8]+".sock")
			tc.setup(t, socket)
			c := New("", Auth{}, "http://127.0.0.1:1", bearer, nil)
			c.OperatorSocket = socket
			var got Text
			c.serveHost(context.Background(), Text{ID: 1, Method: "POST", Path: "/hermes-setup/toolsets/browser"}, func(_ websocket.MessageType, data []byte) error {
				got, _ = DecodeText(data)
				return nil
			}, strings.NewReader(`{"enabled":true}`))
			if got.T != TErr || got.Code != "HERMES_OPERATOR_UNAVAILABLE" || got.Stage != tc.want {
				t.Fatalf("%+v, want stage %s", got, tc.want)
			}
		})
	}
}
