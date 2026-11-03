package connector

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTextRoundTripAndValidation(t *testing.T) {
	ok := []Text{
		{T: THello, Protocol: 1, Agent: "hermes-setup/1.0", HermesVersion: "0.22.2"},
		{T: TCapabilities, Features: []string{FeatureProviderManagement}},
		{T: TCapabilities},
		{T: TLinkIssued, RuntimeID: "rt", LinkToken: "tok"},
		{T: TLinkRotate, RuntimeID: "rt", LinkToken: "tok2"},
		{T: TLinkContext, Environment: "prod", OHB: "https://console.openedbot.app", Organization: &LinkOrganization{ID: "org", Name: "Acme", Slug: "acme"}, Owner: &LinkOwner{Email: "o@example.com"}},
		{T: TLinkContext, Environment: "dev"},
		{T: TAuditKey, RuntimeID: "rt", KeyID: "key-1", Key: strings.Repeat("A", 43) + "=", Previous: []AuditKeyRef{{KeyID: "key-0", Key: strings.Repeat("B", 43) + "="}}},
		{T: TAuditAnchor, RuntimeID: "rt", KeyID: "key-1", WriteSeq: 3, Count: 2, Tail: strings.Repeat("ab", 32)},
		{T: TReq, ID: 7, Method: "POST", Path: "/v1/runs", Headers: map[string]string{"content-type": "application/json"}, Body: "stream"},
		{T: TRes, ID: 7, Status: 200, Headers: map[string]string{"content-type": "text/event-stream"}},
		{T: TEnd, ID: 7}, {T: TCancel, ID: 7},
		{T: TErr, ID: 7, Code: "HERMES_LINK_PATH_FORBIDDEN", Message: "x", Stage: StageBeforeDispatch},
		{T: TPing}, {T: TPong},
	}
	for _, f := range ok {
		b, err := EncodeText(f)
		if err != nil {
			t.Fatalf("%+v: %v", f, err)
		}
		g, err := DecodeText(b)
		if err != nil {
			t.Fatalf("%s: %v", b, err)
		}
		if g.T != f.T || g.ID != f.ID || g.Path != f.Path {
			t.Fatalf("round trip %+v → %+v", f, g)
		}
	}
	bad := []string{
		`{"t":"hello","protocol":2}`, `{"t":"req","id":1,"method":"GET","path":"/health","body":"maybe"}`,
		`{"t":"link.rotate","runtimeId":"rt"}`, `{"t":"res","id":1}`,
		`{"t":"link.context","environment":"staging"}`, `{"t":"link.context","environment":"prod","owner":{"email":"` + strings.Repeat("a", 300) + `"}}`,
		`{"t":"audit.key","runtimeId":"rt","keyId":"key-1","key":"c2hvcnQ="}`, `{"t":"audit.key","runtimeId":"rt","key":"` + strings.Repeat("A", 43) + `="}`,
		`{"t":"audit.anchor","runtimeId":"rt","keyId":"key-1","tail":"nothex"}`, `{"t":"err","id":1,"code":"X","stage":"later"}`,
		`{"t":"exec","id":1}`, `{"t":"end"}`, `not json`,
		`{"t":"capabilities","features":["invalid-feature"]}`,
		`{"t":"capabilities","features":"provider_management"}`,
	}
	for _, s := range bad {
		if _, err := DecodeText([]byte(s)); err == nil {
			t.Errorf("%s accepted", s)
		}
	}
}

// hello and capabilities list up to 64 names, whoever sends them: the bound
// openedbot announces in link.context. The 65th is refused.
func TestFeatureListBound(t *testing.T) {
	names := func(count int) []string {
		out := make([]string, count)
		for i := range out {
			out[i] = fmt.Sprintf("feature_%d", i+1)
		}
		return out
	}
	for _, frame := range []string{THello, TCapabilities} {
		protocol := 0
		if frame == THello {
			protocol = Protocol
		}
		for _, count := range []int{0, 1, 16, 17, 64} {
			b, err := EncodeText(Text{T: frame, Protocol: protocol, Features: names(count)})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := DecodeText(b); err != nil {
				t.Errorf("%s with %d features refused: %v", frame, count, err)
			}
		}
		b, err := EncodeText(Text{T: frame, Protocol: protocol, Features: names(65)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeText(b); err == nil {
			t.Errorf("%s with 65 features accepted", frame)
		}
	}
}

// link.context may carry the bounds openedbot applies. A bound that is
// present must be an integer of at least 1; a limits object without it, an
// unknown bound inside it, and no limits at all announce nothing.
func TestLinkContextLimitsAreValidated(t *testing.T) {
	frame := func(limits string) string {
		return `{"t":"link.context","environment":"prod","ohb":"https://openedbot.app","limits":` + limits + `}`
	}
	for _, limits := range []string{`{"features":64}`, `{"features":16}`, `{"features":1}`, `{}`, `null`, `{"features":null}`, `{"features":64,"requests":10}`} {
		if _, err := DecodeText([]byte(frame(limits))); err != nil {
			t.Errorf("limits %s refused: %v", limits, err)
		}
	}
	for _, limits := range []string{`{"features":0}`, `{"features":-3}`, `{"features":1.5}`, `{"features":"64"}`, `64`, `"64"`, `[64]`} {
		if _, err := DecodeText([]byte(frame(limits))); err == nil {
			t.Errorf("limits %s accepted", limits)
		}
	}
}

func TestBinaryFrames(t *testing.T) {
	b := EncodeBinary(0x01020304, []byte("abc"))
	if len(b) != 7 || b[0] != 1 || b[3] != 4 {
		t.Fatalf("%v", b)
	}
	id, chunk, err := DecodeBinary(b)
	if err != nil || id != 0x01020304 || string(chunk) != "abc" {
		t.Fatalf("%d %q %v", id, chunk, err)
	}
	if _, _, err := DecodeBinary([]byte{1, 2}); err == nil {
		t.Fatal("short frame accepted")
	}
}

// The golden vectors are shared with openedbot's relay-frames.ts.
func TestGoldenVectors(t *testing.T) {
	dir := filepath.Join("..", "..", "test", "golden", "relay-frames")
	data, err := os.ReadFile(filepath.Join(dir, "vectors.json"))
	if err != nil {
		t.Fatalf("missing shared vectors: %v", err)
	}
	var vectors []struct {
		Name   string          `json:"name"`
		Frame  json.RawMessage `json:"frame"`
		Valid  bool            `json:"valid"`
		Binary *struct {
			ID    uint32 `json:"id"`
			Chunk string `json:"chunk"`
			Hex   string `json:"hex"`
		} `json:"binary,omitempty"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		if v.Binary != nil {
			got := EncodeBinary(v.Binary.ID, []byte(v.Binary.Chunk))
			if hexOf(got) != v.Binary.Hex {
				t.Errorf("%s: binary %s want %s", v.Name, hexOf(got), v.Binary.Hex)
			}
			continue
		}
		_, err := DecodeText(v.Frame)
		if (err == nil) != v.Valid {
			t.Errorf("%s: valid=%v err=%v", v.Name, v.Valid, err)
		}
	}
}

func hexOf(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, x := range b {
		out = append(out, digits[x>>4], digits[x&15])
	}
	return string(out)
}

func TestAllowlist(t *testing.T) {
	allowed := map[string]string{
		"GET /health": "", "GET /v1/capabilities": "", "GET /v1/toolsets": "", "GET /api/model/options": "",
		"POST /v1/runs": "", "GET /v1/runs/run_abc": "", "GET /v1/runs/run_abc/events?since=12": "events",
		"POST /v1/runs/run_abc/stop": "", "POST /v1/runs/run_abc/approval": "", "GET /p/prod-1/health": "", "POST /p/prod-1/v1/runs": "",
		"GET /api/sessions/s1": "", "GET /api/sessions/s1/messages": "", "POST /api/sessions": "", "GET /api/mcp/servers": "",
		"DELETE /api/sessions/s1": "", "DELETE /p/prod-1/api/sessions/s1": "",
		// openedbot's REAL session names: `ohb:<org>:<...>`, whose every
		// colon encodeURIComponent writes as `%3A`. The original cases knew only
		// `s1`, a name openedbot never produces, so the list refused all
		// three session routes in production.
		"DELETE /api/sessions/ohb%3A00000000-0000-4000-8000-000000000201%3A57cc181a-554c-41e4-bdd1-b6d360290ddb": "",
		"GET /api/sessions/ohb%3Aorg-1%3Acompact%3Athread%3At-1":                                                 "",
		"GET /api/sessions/ohb%3Aorg-1%3Amemory%3Abot%3Ab-1/messages":                                            "",
		"DELETE /p/prod-1/api/sessions/ohb%3aorg-1%3aworkflow%3aw-1%3abot%3ab-1":                                 "",
		"POST /hermes-setup/providers/openai-codex/credentials":                                                  "host", "POST /hermes-setup/providers/anthropic/oauth": "host",
		"GET /hermes-setup/providers/openai-codex/oauth/abc123": "host", "DELETE /hermes-setup/providers/anthropic/oauth/s-1": "host",
		"POST /p/prod-1/hermes-setup/providers/anthropic/oauth": "host", "GET /hermes-setup/capabilities": "host", "GET /hermes-setup/usage": "host",
		"GET /hermes-setup/provider-sdks": "host",
		// Toolset and MCP verbs: the surface that makes the capability page
		// drivable from openedbot instead of a console on this host.
		"GET /hermes-setup/toolsets": "host", "POST /hermes-setup/toolsets/browser": "host",
		"POST /hermes-setup/toolsets/code_execution": "host", "POST /p/prod-1/hermes-setup/toolsets/web": "host",
		"GET /hermes-setup/mcp/servers": "host", "POST /hermes-setup/mcp/servers": "host",
		"DELETE /hermes-setup/mcp/servers/linear": "host", "POST /hermes-setup/mcp/catalog/n8n": "host",
		// MCP OAuth: the browser leg of an `auth: oauth` server, and the one
		// gateway restart that makes an MCP change visible to runs.
		"POST /hermes-setup/mcp/servers/notion/oauth": "host", "GET /hermes-setup/mcp/servers/notion/oauth/abc123": "host",
		"POST /hermes-setup/mcp/servers/notion/oauth/callback": "host", "DELETE /hermes-setup/mcp/servers/notion/oauth/abc123": "host",
		"GET /hermes-setup/gateway": "host", "POST /hermes-setup/gateway/restart": "host", "GET /hermes-setup/gateway/restart/job1": "host",
		"POST /p/prod-1/hermes-setup/gateway/restart": "host",
		"GET /hermes-setup/sessions-inventory":        "host", "GET /p/prod-1/hermes-setup/sessions-inventory": "host",
		"GET /hermes-setup/a2a/agent-card": "host", "GET /p/prod-1/hermes-setup/a2a/agent-card": "host",
		"GET /hermes-setup/profiles": "host", "GET /hermes-setup/profiles/scout/avatar": "host",
		"GET /p/prod-1/hermes-setup/profiles": "host", "GET /p/prod-1/hermes-setup/profiles/seo-geo/avatar": "host",
		"POST /hermes-setup/profiles": "host", "DELETE /hermes-setup/profiles/scout": "host",
		"POST /hermes-setup/profiles/scout/toolsets/web":                                              "host",
		"POST /hermes-setup/profiles/scout/toolsets":                                                  "host",
		"POST /p/prod-1/hermes-setup/profiles/scout/toolsets":                                         "host",
		"POST /hermes-setup/profiles/scout/model":                                                     "host",
		"POST /p/prod-1/hermes-setup/profiles/scout/model":                                            "host",
		"POST /p/prod-1/hermes-setup/profiles/scout/mcp/servers/linear":                               "host",
		"DELETE /hermes-setup/profiles/scout/mcp/servers/linear":                                      "host",
		"DELETE /p/prod-1/hermes-setup/profiles/scout/mcp/servers/linear":                             "host",
		"POST /hermes-setup/profiles/scout/skills/hermes-agent":                                       "host",
		"POST /hermes-setup/profiles/scout/skills/research":                                           "host",
		"POST /hermes-setup/profiles/scout/bundled-skills":                                            "host",
		"POST /hermes-setup/profiles/seo-geo/providers/anthropic/credentials":                         "host",
		"DELETE /hermes-setup/profiles/scout/providers/openai/credentials":                            "host",
		"POST /p/prod-1/hermes-setup/profiles/scout/providers/xai/credentials":                        "host",
		"POST /hermes-setup/skills/hub/search":                                                        "host",
		"POST /hermes-setup/skills/hub/inspect":                                                       "host",
		"POST /hermes-setup/profiles/scout/skills/hub/scan":                                           "host",
		"POST /hermes-setup/profiles/scout/skills/hub/install":                                        "host",
		"GET /hermes-setup/profiles/scout/skills/hub/operations/11111111-1111-4111-8111-111111111111": "host",
		"DELETE /hermes-setup/profiles/scout/skills/research":                                         "host",
	}
	for k, kind := range allowed {
		m, p, _ := strings.Cut(k, " ")
		r := Match(m, p)
		if r == nil {
			t.Errorf("%s refused", k)
			continue
		}
		if (kind == "events") != r.Events {
			t.Errorf("%s events=%v", k, r.Events)
		}
		if (kind == "host") != r.Host {
			t.Errorf("%s host=%v", k, r.Host)
		}
	}
	for _, k := range []string{
		"DELETE /v1/runs/x", "POST /api/mcp/servers", "GET /v1/browser-control/x", "POST /api/credentials/pool", "GET /auth/password-login",
		"GET /v1/runs/../../etc", "GET /v1/runs//x", "GET /p/BAD/health", "PUT /v1/runs/x", "GET /p/prod-1", "GET /health/extra", "GET v1/health",
		"GET /hermes-setup/providers/x/credentials", "POST /hermes-setup/exec", "POST /hermes-setup/providers/Bad_Slug/credentials",
		"PUT /hermes-setup/providers/x/oauth", "DELETE /hermes-setup/providers/x/credentials", "POST /hermes-setup/providers/x/oauth/s1",
		"GET /hermes-setup/providers/x/usage", "POST /hermes-setup/usage",
		"POST /hermes-setup/a2a/agent-card", "GET /hermes-setup/a2a/agent-card/extra",
		"POST /hermes-setup/a2a/message/send", "GET /hermes-setup/a2a/agent-card/../message/send",
		// A root toolset is never written in bulk (only a profile's are, by
		// POST .../profiles/{slug}/toolsets), and its key admits neither a
		// dash nor an uppercase letter.
		"POST /hermes-setup/toolsets", "GET /hermes-setup/profiles/scout/toolsets",
		"DELETE /hermes-setup/profiles/scout/toolsets", "POST /hermes-setup/profiles/Scout/toolsets", "DELETE /hermes-setup/toolsets/web", "GET /hermes-setup/toolsets/web",
		"POST /hermes-setup/toolsets/Web", "POST /hermes-setup/toolsets/web-search",
		// The catalogue installs, it is not listed through that route, and an
		// MCP server is never edited in place.
		"GET /hermes-setup/mcp/catalog", "PUT /hermes-setup/mcp/servers/linear", "POST /hermes-setup/mcp/servers/linear",
		"DELETE /hermes-setup/mcp/catalog/n8n", "DELETE /hermes-setup/mcp/servers", "GET /hermes-setup/mcp",
		"DELETE /hermes-setup/profiles/scout/mcp/servers", "DELETE /hermes-setup/profiles/scout/mcp/servers/bad%20name",
		"PUT /hermes-setup/profiles/scout/mcp/servers/linear",
		// OAuth names a server and a session; the callback names the server
		// only. The restart names nothing: no unit, no verb, no argument.
		"GET /hermes-setup/mcp/servers/notion/oauth", "PUT /hermes-setup/mcp/servers/notion/oauth",
		"POST /hermes-setup/mcp/servers/notion/oauth/abc123",
		"POST /hermes-setup/mcp/servers/bad%20name/oauth", "POST /hermes-setup/mcp/oauth",
		"POST /hermes-setup/gateway", "DELETE /hermes-setup/gateway", "POST /hermes-setup/gateway/stop",
		"POST /hermes-setup/gateway/restart/job1", "POST /hermes-setup/gateway/restart/hermes-connector",
		"GET /hermes-setup/gateway/restart", "POST /hermes-setup/restart",
		"GET /hermes-setup/profiles/scout", "GET /hermes-setup/profiles/scout/soul",
		"GET /hermes-setup/profiles/scout/model", "PUT /hermes-setup/profiles/scout/model",
		"POST /hermes-setup/profiles/Scout/model",
		"POST /hermes-setup/profiles/scout/models", "DELETE /hermes-setup/profiles/scout/model",
		"POST /hermes-setup/profiles/scout/skills/Web", "POST /hermes-setup/profiles/scout/skills/bad name",
		"POST /hermes-setup/profiles/scout/skills/../etc", "GET /hermes-setup/profiles/scout/skills/research",
		"POST /hermes-setup/profiles/scout/providers/Bad/credentials",
		"GET /hermes-setup/profiles/scout/providers/anthropic/credentials",
		"PUT /hermes-setup/profiles/scout/providers/anthropic/credentials",
		"DELETE /hermes-setup/providers/anthropic/credentials",
		"GET /hermes-setup/profiles/Default/avatar", "GET /hermes-setup/profiles/scout/avatar/extra",
		"GET /hermes-setup/profiles/../etc/passwd/avatar", "GET /hermes-setup/profile",
		"DELETE /api/sessions", "DELETE /api/sessions/s1/messages",
		// `%3A` is the only escape admitted: a `/` or a `.` in percent form
		// would become a path again once the gateway decodes it.
		"DELETE /api/sessions/ohb%2Fetc%2Fpasswd", "DELETE /api/sessions/%2e%2e%2fadmin",
		"DELETE /api/sessions/ohb%3Aorg%25", "DELETE /api/sessions/" + strings.Repeat("a", 257),
	} {
		m, p, _ := strings.Cut(k, " ")
		if Match(m, p) != nil {
			t.Errorf("%s allowed", k)
		}
	}
}

func TestJournalReplayAndBounds(t *testing.T) {
	j, err := NewJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		seq, ok, err := j.Append("run1", "event: run.delta\ndata: {\"i\":"+string(rune('0'+i))+"}", false)
		if err != nil || !ok || seq != uint64(i) {
			t.Fatalf("append %d: %d %v %v", i, seq, ok, err)
		}
	}
	entries, _ := j.After("run1", 1)
	if len(entries) != 2 || entries[0].Seq != 2 {
		t.Fatalf("%+v", entries)
	}
	if got := string(SSEFrame(entries[0])); got != "id: 2\nevent: run.delta\ndata: {\"i\":2}\n\n" {
		t.Fatalf("%q", got)
	}
	done := make(chan struct{})
	go func() {
		time.Sleep(20 * time.Millisecond)
		_, _, _ = j.Append("run1", "event: run.completed\ndata: {}", true)
	}()
	if !j.Wait("run1", 3, done) {
		t.Fatal("wait did not wake on append")
	}
	st := j.Status("run1")
	if st.Seq != 4 || !st.Terminal || !st.Exists {
		t.Fatalf("%+v", st)
	}
	if _, _, err := j.Append("../evil", "x", false); err == nil {
		t.Fatal("path traversal accepted")
	}
	// Reopen: sequence continues from the file.
	j2, _ := NewJournal(j.Dir)
	if seq, _, _ := j2.Append("run1", "event: late\ndata: {}", false); seq != 5 {
		t.Fatalf("seq after reopen = %d", seq)
	}
}

func TestSSEParsing(t *testing.T) {
	blocks := ParseSSEBlocks(": keepalive\n\nid: 9\nevent: run.delta\ndata: {\"a\":1}\n\nevent: run.completed\ndata: {}\n\n")
	if len(blocks) != 2 || blocks[0] != "event: run.delta\ndata: {\"a\":1}" {
		t.Fatalf("%q", blocks)
	}
	if IsTerminal(blocks[0]) || !IsTerminal(blocks[1]) {
		t.Fatal("terminal detection")
	}
}
