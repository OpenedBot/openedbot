package operator

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func serve(t *testing.T, s *Server) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func TestAnMCPWriteMarksTheGatewayRestartPendingUntilItRestarts(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	marker := filepath.Join(t.TempDir(), "pending")
	var restarts, healths int
	recorder := &probeRecorder{replies: map[string]string{
		"mcp-install": `{"server":{"name":"notion","transport":"http","endpoint":"https://mcp.notion.com/mcp","auth":"oauth","configEnabled":true,"platformEnabled":true,"envKeys":[],"oauthTokenPresent":false}}`,
	}}
	s := &Server{
		Probe:          recorder.probe(),
		RestartMarker:  marker,
		Now:            func() time.Time { return now },
		RestartGateway: func(context.Context) error { restarts++; return nil },
		GatewayHealthy: func(context.Context) error { healths++; return nil },
	}
	srv := serve(t, s)
	if got := s.features(); len(got) != 6 || got[5] != "gateway_restart" {
		t.Fatalf("features %v", got)
	}
	if _, out := call(t, srv, "GET", "/gateway", ""); out["restartPending"] != false || out["job"] != nil {
		t.Fatalf("%v", out)
	}
	if st, out := call(t, srv, "POST", "/mcp/catalog/notion", `{"name":"notion"}`); st != 200 || out["oauthTokenPresent"] != false {
		t.Fatalf("%d %v", st, out)
	}
	_, out := call(t, srv, "GET", "/gateway", "")
	if out["restartPending"] != true || out["pendingSince"] != "2026-09-04T10:00:00Z" {
		t.Fatalf("%v", out)
	}
	// A second write keeps the FIRST timestamp: that is the change the
	// gateway missed.
	now = now.Add(time.Minute)
	_, _ = call(t, srv, "POST", "/mcp/catalog/notion", `{"name":"notion"}`)
	if _, out := call(t, srv, "GET", "/gateway", ""); out["pendingSince"] != "2026-09-04T10:00:00Z" {
		t.Fatalf("%v", out)
	}

	st, job := call(t, srv, "POST", "/gateway/restart", `{}`)
	if st != 202 || job["status"] == "" {
		t.Fatalf("%d %v", st, job)
	}
	id := job["jobId"].(string)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/gateway/restart/"+id, "")
		return v["status"] == RestartOK
	})
	_, v := call(t, srv, "GET", "/gateway/restart/"+id, "")
	if v["step"] != StepDone || v["error"] != nil || restarts != 1 || healths != 1 {
		t.Fatalf("%v restarts=%d healths=%d", v, restarts, healths)
	}
	// Proven on /health: the marker is served, and the status carries the job.
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("marker survived a proven restart")
	}
	_, out = call(t, srv, "GET", "/gateway", "")
	if out["restartPending"] != false || out["job"].(map[string]any)["status"] != RestartOK {
		t.Fatalf("%v", out)
	}
	// The finished job vanishes after its TTL.
	now = now.Add(20 * time.Minute)
	if st, _ := call(t, srv, "GET", "/gateway/restart/"+id, ""); st != 404 {
		t.Fatalf("expired job still served: %d", st)
	}
}

func TestGatewayRestartIsProvenOnHealthNotOnSystemctl(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "pending")
	_ = os.WriteFile(marker, []byte("2026-09-04T10:00:00Z\n"), 0o644)
	release := make(chan struct{})
	s := &Server{
		RestartMarker:  marker,
		RestartGateway: func(context.Context) error { <-release; return nil },
		GatewayHealthy: func(context.Context) error { return errors.New("/health returned HTTP 502") },
	}
	srv := serve(t, s)
	st, job := call(t, srv, "POST", "/gateway/restart", `{}`)
	if st != 202 || job["step"] != StepRestart {
		t.Fatalf("%d %v", st, job)
	}
	// One restart at a time: the second request gets the running job back.
	if st, dup := call(t, srv, "POST", "/gateway/restart", `{}`); st != 409 || dup["job"].(map[string]any)["jobId"] != job["jobId"] {
		t.Fatalf("%d %v", st, dup)
	}
	close(release)
	id := job["jobId"].(string)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/gateway/restart/"+id, "")
		return v["status"] == RestartFailed
	})
	_, v := call(t, srv, "GET", "/gateway/restart/"+id, "")
	if v["step"] != StepHealth || v["error"] == nil {
		t.Fatalf("%v", v)
	}
	// systemctl said yes and /health said no: the marker stays.
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("marker cleared without a health proof")
	}
	// A restart that could not even start.
	s.RestartGateway = func(context.Context) error { return errors.New("systemctl: exit 1") }
	_, job = call(t, srv, "POST", "/gateway/restart", `{}`)
	id = job["jobId"].(string)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/gateway/restart/"+id, "")
		return v["status"] == RestartFailed
	})
	if _, v := call(t, srv, "GET", "/gateway/restart/"+id, ""); v["step"] != StepRestart {
		t.Fatalf("%v", v)
	}
}

func TestAConsoleRestartClearsThePendingMarker(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "pending")
	_ = os.WriteFile(marker, []byte("2026-09-04T10:00:00Z\n"), 0o644)
	active := time.Date(2026, 9, 4, 9, 0, 0, 0, time.UTC)
	s := &Server{
		RestartMarker:      marker,
		GatewayActiveSince: func(context.Context) (time.Time, error) { return active, nil },
	}
	srv := serve(t, s)
	// The gateway started BEFORE the write: still pending.
	if _, out := call(t, srv, "GET", "/gateway", ""); out["restartPending"] != true || out["activeSince"] != "2026-09-04T09:00:00Z" {
		t.Fatalf("%v", out)
	}
	// Restarted from the console after the write: the operator must not ask again.
	active = active.Add(2 * time.Hour)
	if _, out := call(t, srv, "GET", "/gateway", ""); out["restartPending"] != false {
		t.Fatalf("%v", out)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("stale marker kept")
	}
	// No restart verb wired: not announced, refused when asked.
	if got := s.features(); len(got) != 2 {
		t.Fatalf("features %v", got)
	}
	if st, out := call(t, srv, "POST", "/gateway/restart", `{}`); st != 503 || errorCode(out) != "GATEWAY_RESTART_UNAVAILABLE" {
		t.Fatalf("%d %v", st, out)
	}
	if st, _ := call(t, srv, "GET", "/gateway/restart/nope", ""); st != 404 {
		t.Fatalf("%d", st)
	}
}

// A gateway that reconciles its MCP servers with the config on every
// housekeeping tick picks an MCP write up by itself: no restart is recorded
// for it, and the host says so (`mcp_live_reload`). Any other cause of the
// marker still records it.
func TestAGatewayThatReconcilesMCPLiveNeedsNoRestartForAnMCPWrite(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "pending")
	recorder := &probeRecorder{replies: map[string]string{
		"profiles":           `{"multiplex":true,"mcpLiveReload":true,"profiles":[]}`,
		"mcp-install":        `{"server":{"name":"notion","transport":"http","endpoint":"https://mcp.notion.com/mcp","auth":"oauth","configEnabled":true,"platformEnabled":true,"envKeys":[],"oauthTokenPresent":false}}`,
		"profile-mcp-remove": `{"profile":"scout","name":"linear","removed":true,"tokensRemoved":true}`,
	}}
	s := &Server{
		Probe:          recorder.probe(),
		RestartMarker:  marker,
		Now:            func() time.Time { return time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC) },
		RestartGateway: func(context.Context) error { return nil },
		GatewayHealthy: func(context.Context) error { return nil },
	}
	s.refreshMultiplex(context.Background())
	srv := serve(t, s)
	_, caps := call(t, srv, "GET", "/capabilities", "")
	features, _ := caps["features"].([]any)
	found := false
	for _, name := range features {
		found = found || name == "mcp_live_reload"
	}
	if !found {
		t.Fatalf("mcp_live_reload not announced: %v", features)
	}
	if st, _ := call(t, srv, "POST", "/mcp/catalog/notion", `{"name":"notion"}`); st != 200 {
		t.Fatalf("install %d", st)
	}
	if st, _ := call(t, srv, "DELETE", "/profiles/scout/mcp/servers/linear", ""); st != 200 {
		t.Fatalf("profile remove %d", st)
	}
	if _, out := call(t, srv, "GET", "/gateway", ""); out["restartPending"] != false {
		t.Fatalf("an MCP write recorded a restart on a live-reloading gateway: %v", out)
	}
	// Not an MCP write: still the boot-time read it always was.
	if err := s.markGatewayRestartPending(); err != nil {
		t.Fatal(err)
	}
	if _, out := call(t, srv, "GET", "/gateway", ""); out["restartPending"] != true {
		t.Fatalf("a non-MCP cause lost its marker: %v", out)
	}
}

// An older gateway (the probe does not report `mcpLiveReload`) loads MCP at
// boot only: the write still records the restart, and the feature is absent.
func TestAnOlderGatewayStillRecordsTheRestartForAnMCPWrite(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "pending")
	recorder := &probeRecorder{replies: map[string]string{
		"profiles":           `{"multiplex":true,"profiles":[]}`,
		"profile-mcp-remove": `{"profile":"scout","name":"linear","removed":true,"tokensRemoved":true}`,
	}}
	s := &Server{Probe: recorder.probe(), RestartMarker: marker, RestartGateway: func(context.Context) error { return nil }}
	s.refreshMultiplex(context.Background())
	for _, name := range s.features() {
		if name == "mcp_live_reload" {
			t.Fatal("mcp_live_reload announced without the probe's proof")
		}
	}
	srv := serve(t, s)
	if st, _ := call(t, srv, "DELETE", "/profiles/scout/mcp/servers/linear", ""); st != 200 {
		t.Fatalf("profile remove %d", st)
	}
	if _, out := call(t, srv, "GET", "/gateway", ""); out["restartPending"] != true {
		t.Fatalf("an older gateway lost its restart marker: %v", out)
	}
}
