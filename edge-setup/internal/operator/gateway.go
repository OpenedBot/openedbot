package operator

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"
)

// An older gateway reads its MCP servers ONCE, when it starts (upstream
// `discover_mcp_tools` at gateway boot; `/reload-mcp` is a chat command that
// api_server runs never reach). There, a server added, installed, authorized
// or removed through the link is invisible to every run until the gateway
// restarts. A current gateway reconciles its live MCP servers with each
// served profile's config on every housekeeping tick (60 s) and refreshes a
// running session's tools between turns: the operator learns which one runs
// from the profiles probe (`mcpLiveReload`) and, for the latter, records no
// restart for an MCP write (markMCPRestartPending).
//
// This file makes the remaining restarts visible and lets the owner act on
// them from openedbot: a marker says « restart pending » from a write that
// happened, and one named verb restarts the gateway unit : and only that
// unit : then proves it on /health.
//
// This is the ONE restart the link carries. It names no unit, no command and
// no argument: the route is fixed, the unit is layout.GatewayUnit, and the
// operator refuses anything else.

const (
	// RestartTimeout bounds the restart step. A graceful restart first lets
	// the running turns finish: Hermes waits up to its
	// `restart_after_turn_timeout` (30 min) before it exits, then systemd
	// relaunches it.
	RestartTimeout = 35 * time.Minute
	// HealthTimeout bounds the /health proof after the restart. A cold
	// interpreter with 78 skills takes a while on a one-vCPU host.
	HealthTimeout = 90 * time.Second
	// RestartJobTTL is how long a finished job stays readable.
	RestartJobTTL = 15 * time.Minute
)

// Restart job statuses and steps.
const (
	RestartRunning = "running"
	RestartOK      = "ok"
	RestartFailed  = "failed"

	StepRestart = "restart"
	StepHealth  = "health"
	StepDone    = "done"
)

// GatewayStatus is the wire shape of GET /hermes-setup/gateway.
type GatewayStatus struct {
	// RestartPending: a change the gateway reads at boot landed after it last
	// started: an MCP write or OAuth authorization, a per-profile MCP toggle,
	// an A2A peer token write, or an edge-setup upgrade that changed the
	// gateway unit's directives while runs were in progress.
	RestartPending bool    `json:"restartPending"`
	PendingSince   *string `json:"pendingSince"`
	// ActiveSince is the gateway unit's ActiveEnterTimestamp, when readable.
	ActiveSince *string `json:"activeSince"`
	// Job is the running or last restart job, when there is one.
	Job *GatewayRestartJob `json:"job"`
}

// GatewayRestartJob is the wire shape of one restart.
type GatewayRestartJob struct {
	JobID      string  `json:"jobId"`
	Status     string  `json:"status"`
	Step       string  `json:"step"`
	StartedAt  string  `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	Error      *string `json:"error"`
	ExpiresAt  string  `json:"expiresAt"`
}

type restartJob struct {
	id         string
	status     string
	step       string
	err        string
	startedAt  time.Time
	finishedAt time.Time
	expiresAt  time.Time
}

// markerPath is where the « restart pending » marker lives; tests point it
// at a temporary file.
func (s *Server) markerPath() string {
	if s.RestartMarker != "" {
		return s.RestartMarker
	}
	return ""
}

// markGatewayRestartPending records that managed configuration, A2A
// credentials or a newly enabled plugin have not been loaded by the running
// gateway. An older marker keeps its timestamp, the first write is the one
// the gateway missed.
func (s *Server) markGatewayRestartPending() error {
	path := s.markerPath()
	if path == "" {
		return nil
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.WriteFile(path, []byte(s.now().UTC().Format(time.RFC3339)+"\n"), 0o644); err != nil {
		s.logf("the gateway restart marker could not be written: %v", err)
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}
	return nil
}

// markMCPRestartPending is markGatewayRestartPending for an MCP write (add,
// install, removal, OAuth authorization, profile toggle or disconnect). A
// gateway that reconciles MCP live picks the change up within a tick, so no
// restart is recorded for it; an older one still needs the restart.
func (s *Server) markMCPRestartPending() error {
	s.mu.Lock()
	live := s.MCPLiveReload
	s.mu.Unlock()
	if live {
		return nil
	}
	return s.markGatewayRestartPending()
}

// clearGatewayRestartPending drops the marker of a gateway that (re)started
// at `at`, which loaded every configuration written before that instant.
func (s *Server) clearGatewayRestartPending(at time.Time) {
	if path := s.markerPath(); path != "" {
		_ = os.Remove(path)
	}
	if s.GatewayRestarted != nil {
		s.GatewayRestarted(at)
	}
}

// pendingSince reads the marker. It is cleared here when the gateway started
// AFTER it : an operator who restarted from the console must not be asked to
// do it again.
func (s *Server) pendingSince(ctx context.Context) (*time.Time, *time.Time) {
	var activeSince *time.Time
	if s.GatewayActiveSince != nil {
		if at, err := s.GatewayActiveSince(ctx); err == nil && !at.IsZero() {
			activeSince = &at
		}
	}
	path := s.markerPath()
	if path == "" {
		return nil, activeSince
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, activeSince
	}
	at, err := time.Parse(time.RFC3339, strings.TrimSpace(string(raw)))
	if err != nil {
		// An unreadable marker is still a marker: the write happened.
		at = s.now()
	}
	if activeSince != nil && activeSince.After(at) {
		s.clearGatewayRestartPending(*activeSince)
		return nil, activeSince
	}
	return &at, activeSince
}

func (s *Server) gatewayStatus(w http.ResponseWriter, r *http.Request) {
	pending, active := s.pendingSince(r.Context())
	s.mu.Lock()
	s.sweepRestartLocked()
	var job *GatewayRestartJob
	if s.restart != nil {
		view := s.restartViewLocked(s.restart)
		job = &view
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, GatewayStatus{
		RestartPending: pending != nil,
		PendingSince:   rfc3339(pending),
		ActiveSince:    rfc3339(active),
		Job:            job,
	})
}

// startGatewayRestart restarts layout.GatewayUnit and proves it on /health.
// One at a time: a second request while one runs gets the running job back
// with 409, never a second `systemctl restart`.
func (s *Server) startGatewayRestart(w http.ResponseWriter, r *http.Request) {
	if s.RestartGateway == nil {
		writeError(w, http.StatusServiceUnavailable, "GATEWAY_RESTART_UNAVAILABLE", "restarting the gateway is not available on this host")
		return
	}
	s.mu.Lock()
	s.sweepRestartLocked()
	if s.restart != nil && s.restart.status == RestartRunning {
		view := s.restartViewLocked(s.restart)
		s.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]string{"code": "GATEWAY_RESTART_IN_PROGRESS", "message": "a gateway restart is already running"},
			"job":   view,
		})
		return
	}
	now := s.now()
	job := &restartJob{id: randomHex(16), status: RestartRunning, step: StepRestart, startedAt: now, expiresAt: now.Add(RestartJobTTL)}
	s.restart = job
	view := s.restartViewLocked(job)
	s.mu.Unlock()
	go s.runRestart(job)
	writeJSON(w, http.StatusAccepted, view)
}

func (s *Server) runRestart(job *restartJob) {
	ctx, cancel := context.WithTimeout(context.Background(), RestartTimeout)
	err := s.RestartGateway(ctx)
	cancel()
	if err != nil {
		s.logf("gateway restart failed: %v", err)
		s.finishRestart(job, RestartFailed, StepRestart, "the gateway unit could not be restarted")
		return
	}
	s.mu.Lock()
	job.step = StepHealth
	s.mu.Unlock()
	if s.GatewayHealthy != nil {
		ctx, cancel = context.WithTimeout(context.Background(), HealthTimeout)
		err = s.GatewayHealthy(ctx)
		cancel()
		if err != nil {
			s.logf("gateway did not come back healthy: %v", err)
			s.finishRestart(job, RestartFailed, StepHealth, "the gateway restarted but did not answer /health in time")
			return
		}
	}
	// The gateway loaded config.yaml as it is now: the marker is served, and
	// the cached inventory : which carries the marker's cause : is stale.
	// The unit restarted after the job began: what was on disk then is loaded.
	s.clearGatewayRestartPending(job.startedAt)
	s.dropReadCache()
	s.finishRestart(job, RestartOK, StepDone, "")
}

func (s *Server) finishRestart(job *restartJob, status, step, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job.status, job.step, job.err = status, step, message
	job.finishedAt = s.now()
	job.expiresAt = job.finishedAt.Add(RestartJobTTL)
}

func (s *Server) pollGatewayRestart(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("job")
	if !sessionRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "GATEWAY_RESTART_NOT_FOUND", "this restart no longer exists")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepRestartLocked()
	if s.restart == nil || s.restart.id != id {
		writeError(w, http.StatusNotFound, "GATEWAY_RESTART_NOT_FOUND", "this restart no longer exists")
		return
	}
	writeJSON(w, http.StatusOK, s.restartViewLocked(s.restart))
}

func (s *Server) restartViewLocked(job *restartJob) GatewayRestartJob {
	var finished *string
	if !job.finishedAt.IsZero() {
		at := job.finishedAt.UTC().Format(time.RFC3339)
		finished = &at
	}
	return GatewayRestartJob{
		JobID: job.id, Status: job.status, Step: job.step,
		StartedAt: job.startedAt.UTC().Format(time.RFC3339), FinishedAt: finished,
		Error: optional(job.err), ExpiresAt: job.expiresAt.UTC().Format(time.RFC3339),
	}
}

// sweepRestartLocked forgets a finished job after its TTL. A running one is
// never swept: it ends when the restart ends.
func (s *Server) sweepRestartLocked() {
	if s.restart != nil && s.restart.status != RestartRunning && s.now().After(s.restart.expiresAt) {
		s.restart = nil
	}
}

func rfc3339(at *time.Time) *string {
	if at == nil {
		return nil
	}
	out := at.UTC().Format(time.RFC3339)
	return &out
}
