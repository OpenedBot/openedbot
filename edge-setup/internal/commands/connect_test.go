package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/acpbridge"
	"github.com/OpenedBot/openedbot/edge-setup/internal/agents"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/coder/websocket"
)

const (
	fakeWorkspaceID = "11111111-1111-4111-8111-111111111111"
	fakeTicket      = "22222222-2222-4222-8222-222222222222.synthetic-ticket"
)

// fakeLinkServer refuses the `revoked` link, issues `renewed` for the ticket,
// then admits `renewed` and closes. With probe, it first asks the agent's
// `/health` through the link, as openedbot does before it issues a runtime.
func fakeLinkServer(t *testing.T, probe bool) *httptest.Server {
	const workspaceID, ticket = fakeWorkspaceID, fakeTicket
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth == "Bearer link:revoked.old-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"LINK_AUTH_INVALID"}}`))
			return
		}
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-connector.v1"}})
		if err != nil {
			t.Error(err)
			return
		}
		defer ws.CloseNow()
		if _, _, err := ws.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		if probe && auth == "Bearer enrollment:"+ticket {
			data, _ := connector.EncodeText(connector.Text{T: connector.TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
			if err := ws.Write(r.Context(), websocket.MessageText, data); err != nil {
				t.Error(err)
				return
			}
			for {
				_, raw, err := ws.Read(r.Context())
				if err != nil {
					t.Error(err)
					return
				}
				reply, err := connector.DecodeText(raw)
				if err == nil && reply.ID == 1 && reply.T == connector.TErr {
					_ = ws.Close(4003, "LINK_PROBE_FAILED")
					return
				}
				if err == nil && reply.ID == 1 && reply.T == connector.TRes && reply.Status == 200 {
					break
				}
			}
		}
		var frame connector.Text
		switch auth {
		case "Bearer enrollment:" + ticket:
			frame = connector.Text{T: connector.TLinkIssued, RuntimeID: "renewed", LinkToken: "new-token"}
		case "Bearer link:renewed.new-token":
			frame = connector.Text{T: connector.TLinkContext, Environment: "dev", Organization: &connector.LinkOrganization{ID: workspaceID}}
		default:
			t.Error("unexpected synthetic credential")
			return
		}
		data, err := connector.EncodeText(frame)
		if err != nil {
			t.Error(err)
			return
		}
		if err := ws.Write(r.Context(), websocket.MessageText, data); err != nil {
			t.Error(err)
			return
		}
		if frame.T == connector.TLinkContext {
			_ = ws.Close(connector.CloseRevoked, "test completed")
		} else {
			_, _, _ = ws.Read(r.Context())
		}
	}))
}

// writeRevokedLink stores the link the fake server refuses.
func writeRevokedLink(t *testing.T, state, origin string) LinkFile {
	key, err := enroll.GenerateDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	link := LinkFile{Schema: 1, Openedbot: origin, WSURL: wsURLOf(origin), RuntimeID: "revoked", LinkToken: "old-token"}
	data, err := json.Marshal(link)
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string][]byte{"link.json": data, "device-key": enroll.EncodeDeviceSeed(key)} {
		if err := fsx.WriteAtomic(filepath.Join(state, name), content, 0600, fsx.Current()); err != nil {
			t.Fatal(err)
		}
	}
	return link
}

func TestConnectReenrollsAfterRevocationAndThenResumes(t *testing.T) {
	const workspaceID, ticket = fakeWorkspaceID, fakeTicket
	server := fakeLinkServer(t, false)
	defer server.Close()
	state := t.TempDir()
	link := writeRevokedLink(t, state, server.URL)
	stdin, input, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stdin.Close() })
	if _, err := input.WriteString(ticket + "\n"); err != nil {
		_ = input.Close()
		t.Fatal(err)
	}
	_ = input.Close()
	previous := os.Stdin
	os.Stdin = stdin
	t.Cleanup(func() { os.Stdin = previous })

	for _, start := range []string{"re-enroll with fresh ticket", "resume with empty stdin"} {
		t.Run(start, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var output bytes.Buffer
			c := connector.New(link.WSURL, connector.Auth{}, "", "", nil)
			c.StopOnInvalidCredential = true
			setup := connectSetup{origin: server.URL, workspaceID: workspaceID}
			agent := localAgent{Agent: agents.Known[0]}
			err := runAgentLink(ctx, cli.Env{Stdout: &output}, state, setup, agent, c, &ticketSource{allowed: true})
			if !errors.Is(err, connector.ErrLinkRefused) || output.String() != "ready local:codex\n" {
				t.Fatalf("expected admission followed by the simulated close, got %v (%q)", err, output.String())
			}
		})
	}
}

// A service run never prompts: an unpaired agent says to pair again.
func TestConnectServiceNeverAsksForATicket(t *testing.T) {
	if _, err := (&ticketSource{allowed: false}).get(); !errors.Is(err, errServicePairing) {
		t.Fatalf("service ticket: %v", err)
	}
}

func TestConnectUnitQuotesItsCommand(t *testing.T) {
	setup := connectSetup{workspace: "/home/me/my 100% ${HOME} project", path: "/usr/bin:/home/me/.bun/bin"}
	unit := renderSystemdUnit(setup, []string{"/opt/edge setup", "connect", "--workspace", setup.workspace})
	for _, want := range []string{
		`ExecStart="/opt/edge setup" "connect" "--workspace" "/home/me/my 100%% $${HOME} project"`,
		`Environment="PATH=/usr/bin:/home/me/.bun/bin"`,
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("unit lacks %q:\n%s", want, unit)
		}
	}
}

// The service never prompts: a stored link the API refuses is replaced by the
// ticket during the interactive pairing, before the service starts.
// The pairing answers openedbot's probe through the agent's bridge: without
// it, openedbot closes the link with LINK_PROBE_FAILED.
func TestConnectPairingReplacesARevokedStoredLink(t *testing.T) {
	server := fakeLinkServer(t, true)
	defer server.Close()
	setup := connectSetup{origin: server.URL, workspaceID: fakeWorkspaceID, root: t.TempDir(), workspace: t.TempDir()}
	agent := localAgent{Agent: agents.Known[0], path: "/bin/true", catalogue: &acpbridge.Catalogue{Provider: "openai-codex", Name: "Codex CLI", Version: "test", Models: []acpbridge.AgentModel{{ID: "m", Default: true}}}}
	if err := fsx.EnsureDir(agentState(setup, agent), 0700, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	writeRevokedLink(t, agentState(setup, agent), server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := pairAgent(ctx, cli.Env{Version: "test"}, setup, agent, &ticketSource{allowed: true, value: fakeTicket}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(agentState(setup, agent), "link.json"))
	if err != nil || !strings.Contains(string(data), `"runtime_id":"renewed"`) {
		t.Fatalf("link not replaced: %s %v", data, err)
	}
}

func TestConnectServiceGetsTheAgentSettings(t *testing.T) {
	setup := connectSetup{root: t.TempDir()}
	t.Setenv("CODEX_HOME", "/home/me/.codex-work")
	t.Setenv("OPENAI_API_KEY", "not-for-agents")
	if err := saveAgentSettings(setup); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(agentSettingsFile(setup))
	if strings.Contains(string(data), "OPENAI_API_KEY") {
		t.Fatalf("unnamed variable saved: %s", data)
	}
	t.Setenv("CODEX_HOME", "")
	if err := loadAgentSettings(setup); err != nil || os.Getenv("CODEX_HOME") != "/home/me/.codex-work" {
		t.Fatalf("CODEX_HOME=%q %v", os.Getenv("CODEX_HOME"), err)
	}
}

// The service reads the pairing's own state root, whatever its XDG_CONFIG_HOME.
func TestConnectServiceKeepsThePairingStateRoot(t *testing.T) {
	setup := connectSetup{origin: "http://127.0.0.1:8790", workspaceID: fakeWorkspaceID, workspace: "/w", root: "/custom/config/openedbot-connect/abc"}
	args, err := connectServiceArgs(setup)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(args[1:], " "); !strings.HasSuffix(got, "--state-root /custom/config/openedbot-connect/abc") || !strings.HasPrefix(got, "connect --serve") {
		t.Fatalf("service args: %s", got)
	}
}
