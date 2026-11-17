package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hostfacts"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
	"github.com/coder/websocket"
)

func TestEngineSelectionAndSwitchRefusal(t *testing.T) {
	for _, tc := range []struct {
		name, os, old string
		want          string
	}{{"hermes", "linux", "", ""}, {"acp:opencode", "linux", "", ""}, {"acp:opencode", "linux", "acp:opencode", ""}, {"acp:opencode", "linux", "hermes", "uninstall first"}, {"hermes", "linux", "acp:opencode", "uninstall first"}, {"acp:opencode", "darwin", "", "Linux with systemd only"}, {"acp:other", "linux", "", "--engine must be"}} {
		var st *state.File
		if tc.old != "" {
			st = state.New("test")
			st.Engine = tc.old
		}
		err := validateEngine(tc.name, tc.os, st, false)
		if tc.want == "" {
			if err != nil {
				t.Fatal(err)
			}
		} else if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	o := bindUpFlags(fs)
	if o.engine != "hermes" {
		t.Fatal("default engine changed")
	}
	if err := fs.Parse([]string{"--engine", "acp:opencode"}); err != nil || o.engine != state.EngineOpenCode {
		t.Fatal("ACP flag unavailable")
	}
	if !strings.Contains(fs.Lookup("engine").Usage, "experimental") {
		t.Fatal("missing experimental warning")
	}
}

func TestEnginePlansPreserveHermesAndDescribeACP(t *testing.T) {
	facts := hostfacts.Facts{OSID: "debian", OSVersionID: 13, Arch: "amd64"}
	for _, features := range []state.Features{{}, {Sandbox: true, Firewall: true}} {
		if !reflect.DeepEqual(enginePlanLines("hermes", features, facts), planLines(features, facts)) {
			t.Fatal("Hermes plan changed")
		}
	}
	lines := strings.Join(enginePlanLines(state.EngineOpenCode, state.Features{}, facts), "\n")
	if !strings.Contains(lines, "experimental OpenCode "+pins.OpenCodeVersion) || !strings.Contains(lines, "openedbot-acp-bridge") || strings.Contains(lines, "P5 runtime     Hermes") {
		t.Fatal("ACP plan does not identify its runtime")
	}
}

func TestACPConnectorHelloOnWire(t *testing.T) {
	received := make(chan map[string]json.RawMessage, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-connector.v1"}})
		if err != nil {
			return
		}
		defer ws.CloseNow()
		_, data, err := ws.Read(r.Context())
		if err != nil {
			return
		}
		var doc map[string]json.RawMessage
		if json.Unmarshal(data, &doc) != nil {
			return
		}
		received <- doc
	}))
	defer server.Close()
	c := connector.New("ws"+strings.TrimPrefix(server.URL, "http"), connector.Auth{RuntimeID: "fixture", LinkToken: "fixture"}, "http://127.0.0.1:8642", "fixture", nil)
	configureConnectorEngine(c, state.EngineOpenCode)
	c.Agent = "edge-setup/test"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); _ = c.Session(ctx) }()
	select {
	case doc := <-received:
		var engine, version string
		_ = json.Unmarshal(doc["engine"], &engine)
		_ = json.Unmarshal(doc["engineVersion"], &version)
		if engine != state.EngineOpenCode || version != pins.OpenCodeVersion {
			t.Fatal("wrong ACP engine identity")
		}
		if _, ok := doc["hermesVersion"]; ok {
			t.Fatal("ACP hello carries hermesVersion")
		}
	case <-ctx.Done():
		t.Fatal("no hello")
	}
	cancel()
	<-done
}

func TestDoctorACPDoesNotRunHermesChecks(t *testing.T) {
	oldLoad, oldRunner := loadHostState, runner
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/bin/systemctl ", exec.Result{Stdout: "active\n"})
	fake.On("/usr/bin/ss -H -ltn", exec.Result{Stdout: "LISTEN 0 128 127.0.0.1:8642 0.0.0.0:*\n"})
	runner = fake
	t.Cleanup(func() { loadHostState = oldLoad; runner = oldRunner })
	st := state.New("test")
	st.Engine = state.EngineOpenCode
	loadHostState = func() (*state.File, error) { return st, nil }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(200)
			return
		}
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(401)
			return
		}
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	defer server.Close()
	oldGateway, oldToken := doctorGateway, doctorToken
	doctorGateway = func(token string) gateway.Client {
		return gateway.Client{BaseURL: server.URL, Token: token, HTTP: server.Client()}
	}
	doctorToken = func() (string, error) { return "fixture", nil }
	t.Cleanup(func() { doctorGateway = oldGateway; doctorToken = oldToken })
	problems, _ := doctor(context.Background())
	for _, p := range problems {
		if strings.Contains(p, "loopback") || strings.Contains(p, "toolset") {
			t.Fatal(p)
		}
	}
	if !fake.Ran("/usr/bin/systemctl is-active --quiet openedbot-acp-bridge") || !fake.Ran("/usr/bin/ss -H -ltn") {
		t.Fatal("missing ACP health checks")
	}
	for _, command := range fake.Commands() {
		if strings.Contains(command, "hermes-gateway") || strings.Contains(command, "multiplex_profiles") || strings.Contains(command, "python") {
			t.Fatal("Hermes check on ACP host", command)
		}
	}
}

func TestEngineSwitchRefusedBeforeAnyHostCommand(t *testing.T) {
	oldLoad, oldRunner := loadHostState, runner
	fake := exectest.NewFake()
	runner = fake
	t.Cleanup(func() { loadHostState = oldLoad; runner = oldRunner })
	st := state.New("test")
	st.Engine = state.EngineOpenCode
	loadHostState = func() (*state.File, error) { return st, nil }
	var out bytes.Buffer
	// dry-run shares the engine gate and never needs root or host facts.
	code := runUp(cli.Env{Stdout: &out, Stderr: &out}, []string{"--engine", "hermes", "--dry-run"})
	if code != cli.ExitRefused || !strings.Contains(out.String(), "uninstall first") || len(fake.Commands()) != 0 {
		t.Fatalf("gate: %d, %s", code, out.String())
	}
}

func TestUpgradeProofUsesACPUnitAndHealth(t *testing.T) {
	st := state.New("test")
	st.Engine = state.EngineOpenCode
	for _, active := range []bool{false, true} {
		f := exectest.NewFake()
		code := 1
		if active {
			code = 0
		}
		f.On("/usr/bin/systemctl is-active --quiet openedbot-acp-bridge", exec.Result{ExitCode: code})
		checked := false
		err := proveEngineRuntime(context.Background(), systemd.Client{Runner: f}, st, func(context.Context) error { checked = true; return nil })
		if (err == nil) != active || checked != active {
			t.Fatalf("active=%v checked=%v error=%v", active, checked, err)
		}
		if len(f.Commands()) != 1 {
			t.Fatal("unexpected runtime commands", f.Commands())
		}
	}
}
