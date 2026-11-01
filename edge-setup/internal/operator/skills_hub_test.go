package operator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSkillIdentifierClass(t *testing.T) {
	for _, value := range []string{"official/daily-brief", "skills-sh/org/repo/skill", "github/Owner/repo/path", "NVIDIA/skills/skills/tao-run-on-kubernetes"} {
		if !validSkillIdentifier(value) {
			t.Errorf("valid identifier rejected: %q", value)
		}
	}
	if !validSkillIdentifier(strings.Repeat("a", 8) + "/" + strings.Repeat("b", 191)) {
		t.Error("a 200-character identifier was rejected")
	}
	for _, value := range []string{"well-known:https://x", "a/b/../c", "a/b//c", "a/../b", "a//b", "a/b c", "a/b:ref", strings.Repeat("a", 9) + "/" + strings.Repeat("b", 191)} {
		if validSkillIdentifier(value) {
			t.Errorf("invalid identifier accepted: %q", value)
		}
	}
}

func TestSkillSearchBoundsAndUnknownFields(t *testing.T) {
	s := &Server{Probe: func(context.Context, string, []byte) ([]byte, error) { return []byte(`[]`), nil }, SkillsHubReady: true}
	h := s.Handler()
	for _, body := range []string{
		`{"query":""}`, `{"query":"` + strings.Repeat("x", 101) + `"}`,
		`{"query":"x","source":"well-known"}`, `{"query":"x","source":"unknown"}`,
		`{"query":"x","limit":0}`, `{"query":"x","limit":26}`, `{"query":"x","extra":true}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/skills/hub/search", strings.NewReader(body))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d", body[:min(30, len(body))], rec.Code)
		}
	}
}

func TestSkillSearchDecodesArrayProbeResponse(t *testing.T) {
	s := &Server{Probe: func(context.Context, string, []byte) ([]byte, error) {
		return []byte(`[{"name":"Research","identifier":"official/research","source":"official","trustLevel":"official","description":"A brief."}]`), nil
	}, SkillsHubReady: true}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/skills/hub/search", strings.NewReader(`{"query":"research"}`)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"official/research"`) {
		t.Fatalf("successful search was not decoded: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSkillOperationDirUsesDurableLinuxState(t *testing.T) {
	s := &Server{}
	want := filepath.Join("/var/lib/hermes-operator", "skills-hub-operations")
	if got := s.skillOperationDir(); got != want {
		t.Fatalf("Linux skill operation directory = %q, want %q", got, want)
	}
}

func TestSkillOperationTrustAndPolicyGuards(t *testing.T) {
	for _, tc := range []struct{ name, policy, trust, source, code string }{
		{"community allow", "allow", "community", "github", "SKILL_TRUST_REFUSED"},
		{"ask blocks", "ask", "trusted", "official", "SKILL_SCAN_BLOCKED"},
	} {
		s := &Server{Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
			if verb == "skills-hub-scan" {
				return []byte(`{"policy":"` + tc.policy + `","trustLevel":"` + tc.trust + `","source":"` + tc.source + `","verdict":"safe","findings":[]}`), nil
			}
			return []byte(`{"profiles":[]}`), nil
		}, SkillsHubReady: true}
		op := &skillOperation{OperationID: newSkillOperationID(), Profile: "scout", Identifier: "github/a/skill", State: "queued", CreatedAt: time.Now()}
		s.runSkillInstall(op)
		if op.State != "failed" || op.Error == nil || op.Error.Code != tc.code {
			t.Fatalf("%s: %+v", tc.name, op)
		}
	}
}

func TestSkillOperationPersistenceMarksRunningInterrupted(t *testing.T) {
	dir := t.TempDir()
	id := "11111111-1111-4111-8111-111111111111"
	op := skillOperationDisk{OperationID: id, Profile: "scout", Identifier: "official/a", State: "running", CreatedAt: time.Now().Add(-time.Hour)}
	raw, _ := json.Marshal(op)
	if err := os.WriteFile(filepath.Join(dir, id+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Server{SkillsOperationDir: dir, Probe: func(context.Context, string, []byte) ([]byte, error) { return []byte(`{"available":true}`), nil }, SkillsHubReady: true}
	_ = s.Handler()
	s.mu.Lock()
	got := s.skillOps[id]
	s.mu.Unlock()
	if got == nil || got.State != "failed" || got.Error == nil || got.Error.Code != "OPERATION_INTERRUPTED" {
		t.Fatalf("%+v", got)
	}
}

func TestSkillInstallRequiresProfileReadbackAndDeleteReadsItAgain(t *testing.T) {
	profiles := `{"profiles":[{"name":"scout","skills":[{"name":"daily-brief","enabled":true}]}]}`
	profileReads := 0
	s := &Server{SkillsOperationDir: t.TempDir(), SkillsHubReady: true, Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		switch verb {
		case "skills-hub-scan":
			return []byte(`{"policy":"allow","trustLevel":"trusted","source":"official","verdict":"safe","findings":[]}`), nil
		case "skills-hub-install", "skills-hub-uninstall":
			return []byte(`{"ok":true}`), nil
		case "profiles":
			profileReads++
			if profileReads > 1 {
				return []byte(`{"profiles":[{"name":"scout","skills":[]}]}`), nil
			}
			return []byte(profiles), nil
		default:
			return []byte(`{}`), nil
		}
	}}
	op := &skillOperation{OperationID: newSkillOperationID(), Profile: "scout", Identifier: "official/daily-brief", State: "queued", CreatedAt: time.Now()}
	s.runSkillInstall(op)
	if op.State != "succeeded" || op.Skills == nil || len(op.Skills) != 1 {
		t.Fatalf("successful install was not proven: %+v", op)
	}
	req := httptest.NewRequest(http.MethodDelete, "/profiles/scout/skills/daily-brief", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"skills":[]`) {
		t.Fatalf("delete readback: %d %s", rec.Code, rec.Body.String())
	}

	s.Probe = func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		if verb == "skills-hub-scan" {
			return []byte(`{"policy":"allow","trustLevel":"trusted","source":"official","verdict":"safe","findings":[]}`), nil
		}
		if verb == "skills-hub-install" {
			return []byte(`{"ok":true}`), nil
		}
		return []byte(`{"profiles":[{"name":"scout","skills":[]}]}`), nil
	}
	op = &skillOperation{OperationID: newSkillOperationID(), Profile: "scout", Identifier: "official/missing", State: "queued", CreatedAt: time.Now()}
	s.runSkillInstall(op)
	if op.Error == nil || op.Error.Code != "SKILL_INSTALL_UNVERIFIED" {
		t.Fatalf("missing readback was accepted: %+v", op)
	}
}

func TestSkillOperationRequiresTheProfileInThePath(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	s := &Server{SkillsOperationDir: t.TempDir(), SkillsHubReady: true, Probe: func(context.Context, string, []byte) ([]byte, error) { return []byte(`{}`), nil }}
	s.skillOps = map[string]*skillOperation{id: {OperationID: id, Profile: "alpha", Identifier: "official/a", State: "running"}}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/profiles/beta/skills/hub/operations/"+id, nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "SKILL_OPERATION_NOT_FOUND") {
		t.Fatalf("cross-profile operation lookup was exposed: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSkillUninstallRequiresAbsenceAfterReadback(t *testing.T) {
	s := &Server{SkillsHubReady: true, Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		if verb == "profiles" {
			return []byte(`{"profiles":[{"name":"scout","skills":[{"name":"daily-brief","enabled":true}]}]}`), nil
		}
		return []byte(`{"ok":true}`), nil
	}}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/profiles/scout/skills/daily-brief", nil))
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "SKILL_UNINSTALL_UNVERIFIED") {
		t.Fatalf("unverified uninstall was accepted: %d %s", rec.Code, rec.Body.String())
	}
}

func TestConcurrentSkillInstallReturnsConflictPerProfile(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	s := &Server{SkillsOperationDir: t.TempDir(), SkillsHubReady: true, Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		if verb == "skills-hub-scan" {
			select {
			case <-started:
			default:
				close(started)
			}
			<-release
		}
		return []byte(`{"policy":"allow","trustLevel":"community","source":"github","verdict":"safe","findings":[]}`), nil
	}}
	h := s.Handler()
	first := httptest.NewRecorder()
	go h.ServeHTTP(first, httptest.NewRequest(http.MethodPost, "/profiles/scout/skills/hub/install", strings.NewReader(`{"identifier":"github/a/skill"}`)))
	<-started
	second := httptest.NewRecorder()
	h.ServeHTTP(second, httptest.NewRequest(http.MethodPost, "/profiles/scout/skills/hub/install", strings.NewReader(`{"identifier":"github/b/skill"}`)))
	close(release)
	if second.Code != http.StatusConflict {
		t.Fatalf("concurrent install status %d: %s", second.Code, second.Body.String())
	}
	// The first install finishes in the background and persists its
	// operation file: wait for a terminal state so the temporary directory
	// is not removed under that write.
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		pending := false
		for _, op := range s.skillOps {
			if op.State == "queued" || op.State == "running" {
				pending = true
			}
		}
		s.mu.Unlock()
		if !pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the first install never reached a terminal state")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A search answers from the cached indexes, then refreshes them in the
// background: once at a time, and at most once per interval.
func TestSkillSearchRefreshesIndexesInTheBackgroundOnce(t *testing.T) {
	var mu sync.Mutex
	verbs := map[string]int{}
	release := make(chan struct{})
	clock := time.Date(2026, 10, 21, 17, 0, 0, 0, time.UTC)
	s := &Server{SkillsHubReady: true, Now: func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }}
	s.Probe = func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		mu.Lock()
		verbs[verb]++
		mu.Unlock()
		if verb == "skills-hub-refresh" {
			<-release
			return []byte(`{"refreshed":true}`), nil
		}
		return []byte(`[]`), nil
	}
	search := func() {
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/skills/hub/search", strings.NewReader(`{"query":"docker"}`)))
		if rec.Code != http.StatusOK {
			t.Fatalf("search answered %d while a refresh was pending: %s", rec.Code, rec.Body.String())
		}
	}
	waitRefresh := func() {
		s.skillsHubRefresh.mu.Lock()
		done := s.skillsHubRefresh.done
		s.skillsHubRefresh.mu.Unlock()
		<-done
	}
	count := func(verb string) int { mu.Lock(); defer mu.Unlock(); return verbs[verb] }

	search()
	// A search arriving while the refresh runs waits for it, then reads the
	// rebuilt cache: no second refresh, no parallel download.
	answered := make(chan struct{})
	go func() { search(); close(answered) }()
	select {
	case <-answered:
		t.Fatal("a search during a refresh did not wait for it")
	case <-time.After(100 * time.Millisecond):
	}
	if got := count("skills-hub-search"); got != 1 {
		t.Fatalf("the waiting search reached the probe before the refresh ended: %d", got)
	}
	close(release)
	<-answered
	waitRefresh()
	if got := count("skills-hub-refresh"); got != 1 {
		t.Fatalf("refreshes after two searches = %d, want 1", got)
	}
	search() // within the interval
	if got := count("skills-hub-refresh"); got != 1 {
		t.Fatalf("refresh re-ran within the interval: %d", got)
	}
	mu.Lock()
	clock = clock.Add(skillsHubRefreshInterval)
	mu.Unlock()
	release = make(chan struct{})
	search() // past the interval: starts a periodic refresh, held open
	// Once warmed, a search never waits on a periodic refresh: the cached
	// indexes answer it at once.
	answered = make(chan struct{})
	go func() { search(); close(answered) }()
	select {
	case <-answered:
	case <-time.After(2 * time.Second):
		t.Fatal("a search waited on a periodic refresh after the warm-up")
	}
	close(release)
	waitRefresh()
	if got, searches := count("skills-hub-refresh"), count("skills-hub-search"); got != 2 || searches != 5 {
		t.Fatalf("refreshes=%d searches=%d, want 2 and 5", got, searches)
	}
}

// Enabling the hub (first features listing, at the connector's hello) warms
// the indexes before anyone searches.
func TestSkillsHubEnabledWarmsTheIndexes(t *testing.T) {
	refreshed := make(chan struct{}, 1)
	s := &Server{Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		switch verb {
		case "skills-hub-capabilities":
			return []byte(`{"available":true}`), nil
		case "skills-hub-refresh":
			refreshed <- struct{}{}
			return []byte(`{"refreshed":true}`), nil
		}
		return []byte(`{}`), nil
	}}
	if !s.skillsHubEnabled() {
		t.Fatal("hub not enabled")
	}
	select {
	case <-refreshed:
	case <-time.After(5 * time.Second):
		t.Fatal("enabling the hub did not warm its indexes")
	}
}

// The foreground search and inspect serve any cached index (upstream TTLs
// lifted), the background refresh keeps the upstream TTLs, and a pin without
// those constants still searches.
func TestSkillsHubProbeServesStaleIndexesOnlyInTheForeground(t *testing.T) {
	code := `import json, sys, types
scope = {"__name__": "skills_hub_probe_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
tools = types.ModuleType("tools")
hub = types.ModuleType("tools.skills_hub")
search_mod = types.ModuleType("tools.skills_hub_search")
cli = types.ModuleType("hermes_cli")
cli_hub = types.ModuleType("hermes_cli.skills_hub")
sys.modules.update({"tools": tools, "tools.skills_hub": hub, "tools.skills_hub_search": search_mod,
                    "hermes_cli": cli, "hermes_cli.skills_hub": cli_hub})
seen = []
def do_search(query, source="all", limit=10, as_json=False):
    seen.append((query, getattr(hub, "INDEX_CACHE_TTL", None), getattr(search_mod, "HERMES_INDEX_TTL", None)))
    print("[]")
cli_hub.do_search = do_search
cli_hub.inspect_skill = lambda identifier: (seen.append(("inspect", hub.INDEX_CACHE_TTL, search_mod.HERMES_INDEX_TTL)), {"name": "x"})[1]
def reset():
    hub.INDEX_CACHE_TTL, search_mod.HERMES_INDEX_TTL = 3600, 21600
reset()
assert scope["HANDLERS"]["skills-hub-refresh"]({}) == {"refreshed": True}
reset()
scope["HANDLERS"]["skills-hub-search"]({"query": "docker", "source": "all", "limit": 5})
reset()
scope["HANDLERS"]["skills-hub-inspect"]({"identifier": "official/devops/docker-management"})
del hub.INDEX_CACHE_TTL
scope["HANDLERS"]["skills-hub-search"]({"query": "docker", "source": "all", "limit": 5})
stale = scope["HUB_STALE_SERVE_TTL"]
assert seen[0] == ("skill", 3600, 21600), seen[0]
assert seen[1] == ("docker", stale, stale), seen[1]
assert seen[2] == ("inspect", stale, stale), seen[2]
assert seen[3] == ("docker", None, stale), seen[3]
print("ok")
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	output, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) != "ok" {
		t.Fatalf("skills hub probe: %v\n%s", err, output)
	}
}
