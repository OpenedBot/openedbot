package acpbridge

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Limits struct {
	MaxConcurrentRuns int
	IdleTimeout       time.Duration
	RPCTimeout        time.Duration
	TurnTimeout       time.Duration
	CancelTimeout     time.Duration
	BodyTimeout       time.Duration
	MaxInvalidLines   int
}
type Options struct {
	ListenAddress  string
	Bearer         string
	StateDirectory string
	ProfilesRoot   string
	AgentCommand   string
	AgentArguments []string
	// AgentEnvironment lists additional environment variable names to pass.
	AgentEnvironment []string
	Limits           Limits
}

// Bridge owns its agent processes and durable run journal. Close must precede
// reopening the same state directory; one bridge owns a directory at a time.
type Bridge struct {
	ctx             context.Context
	cancel          context.CancelFunc
	mu              sync.Mutex
	opts            Options
	disk            diskState
	profiles        map[string]*profile
	changed         chan struct{}
	closed          bool
	diskErr         error
	dirtyEvents     map[string]bool
	maintenanceDone chan struct{}
	wg              sync.WaitGroup
	outgoing        []agentWrite
}
type diskState struct {
	Sessions map[string]*session `json:"sessions"`
	Runs     map[string]*run     `json:"runs"`
}
type session struct {
	Profile      string    `json:"profile"`
	ID           string    `json:"id"`
	ACPID        string    `json:"acp_id"`
	Instructions string    `json:"instructions"`
	Used         bool      `json:"used"`
	LastUsed     time.Time `json:"last_used"`
	client       *rpcClient
	active       string
}
type Event map[string]any
type run struct {
	ID             string    `json:"run_id"`
	Profile        string    `json:"profile"`
	SessionID      string    `json:"session_id"`
	Key            string    `json:"key"`
	Status         string    `json:"status"`
	Output         string    `json:"-"`
	Events         []Event   `json:"-"`
	Cancel         bool      `json:"cancel"`
	Generation     int       `json:"execution_generation"`
	InvalidLines   int       `json:"invalid_stdout_lines"`
	UnmatchedTools int       `json:"unmatched_tool_completions"`
	TerminalAt     time.Time `json:"terminal_at,omitempty"`
	timedOut       bool
	permissions    map[string]permission
	tools          map[string]string
	bytes          int
	client         *rpcClient
	acpID          string
}
type permission struct {
	id      json.RawMessage
	options map[string]string
}
type profile struct {
	mu     sync.Mutex
	client *rpcClient
	caps   agentCapabilities
	idle   *time.Timer
	busy   int
}
type agentCapabilities struct {
	LoadSession bool `json:"loadSession"`
	Prompt      struct {
		Image bool `json:"image"`
	} `json:"promptCapabilities"`
	Session struct {
		SystemPrompt *json.RawMessage `json:"systemPrompt"`
	} `json:"sessionCapabilities"`
}

var slugPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func New(opts Options) (*Bridge, error) {
	host, _, err := net.SplitHostPort(opts.ListenAddress)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return nil, errors.New("listen address must be a loopback IP and port")
	}
	if opts.Bearer == "" || opts.StateDirectory == "" || opts.ProfilesRoot == "" || opts.AgentCommand == "" {
		return nil, errors.New("bearer, state directory, profiles root and agent command are required")
	}
	opts.ProfilesRoot, err = filepath.Abs(opts.ProfilesRoot)
	if err != nil {
		return nil, err
	}
	if opts.Limits.MaxConcurrentRuns == 0 {
		opts.Limits.MaxConcurrentRuns = 4
	}
	if opts.Limits.MaxConcurrentRuns < 1 || opts.Limits.MaxConcurrentRuns > 4 {
		return nil, errors.New("max concurrent runs must be between 1 and 4")
	}
	if opts.Limits.IdleTimeout == 0 {
		opts.Limits.IdleTimeout = 5 * time.Minute
	}
	if opts.Limits.RPCTimeout == 0 {
		opts.Limits.RPCTimeout = 30 * time.Second
	}
	if opts.Limits.TurnTimeout == 0 {
		opts.Limits.TurnTimeout = 30 * time.Minute
	}
	if opts.Limits.CancelTimeout == 0 {
		opts.Limits.CancelTimeout = 5 * time.Second
	}
	if opts.Limits.BodyTimeout == 0 {
		opts.Limits.BodyTimeout = 5 * time.Second
	}
	if opts.Limits.MaxInvalidLines == 0 {
		opts.Limits.MaxInvalidLines = 8
	}
	if opts.Limits.IdleTimeout < 0 || opts.Limits.RPCTimeout < 0 || opts.Limits.TurnTimeout < 0 || opts.Limits.CancelTimeout < 0 || opts.Limits.BodyTimeout < 0 || opts.Limits.MaxInvalidLines < 0 {
		return nil, errors.New("limits must be positive")
	}
	if err = os.MkdirAll(opts.StateDirectory, 0700); err != nil {
		return nil, err
	}
	b := &Bridge{opts: opts, profiles: map[string]*profile{}, changed: make(chan struct{}), disk: diskState{Sessions: map[string]*session{}, Runs: map[string]*run{}}}
	b.ctx, b.cancel = context.WithCancel(context.Background())
	b.dirtyEvents = map[string]bool{}
	if err = os.MkdirAll(filepath.Join(opts.StateDirectory, "events"), 0700); err != nil {
		b.cancel()
		return nil, err
	}
	raw, err := os.ReadFile(filepath.Join(opts.StateDirectory, "state.json"))
	if err == nil {
		if err = json.Unmarshal(raw, &b.disk); err != nil {
			b.cancel()
			return nil, fmt.Errorf("read bridge state: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		b.cancel()
		return nil, err
	}
	if b.disk.Sessions == nil || b.disk.Runs == nil {
		b.cancel()
		return nil, errors.New("invalid bridge state maps")
	}
	for _, r := range b.disk.Runs {
		if err = b.readEvents(r); err != nil {
			b.cancel()
			return nil, err
		}
		if !terminal(r.Status) {
			b.finishLocked(r, "interrupted", "bridge restarted")
		}
	}
	if b.diskErr != nil {
		b.cancel()
		return nil, b.diskErr
	}
	b.pruneLocked(time.Now())
	if b.diskErr != nil {
		b.cancel()
		return nil, b.diskErr
	}
	b.maintenanceDone = make(chan struct{})
	go b.maintain()
	return b, nil
}
func terminal(s string) bool {
	return s == "completed" || s == "failed" || s == "interrupted" || s == "cancelled"
}
func uniqueID() string {
	var x [16]byte
	if _, err := rand.Read(x[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(x[:])
}
func sessionKey(profile, id string) string { return profile + "/" + id }
func (b *Bridge) saveLocked() {
	if b.diskErr != nil {
		return
	}
	if err := b.syncEventsLocked(); err != nil {
		b.diskErr = err
		b.wakeLocked()
		return
	}
	raw, err := json.Marshal(b.disk)
	if err == nil {
		var f *os.File
		f, err = os.CreateTemp(b.opts.StateDirectory, ".state-*")
		if err == nil {
			name := f.Name()
			defer os.Remove(name)
			_, err = f.Write(raw)
			if err == nil {
				err = f.Sync()
			}
			closeErr := f.Close()
			if err == nil {
				err = closeErr
			}
			if err == nil {
				err = os.Rename(name, filepath.Join(b.opts.StateDirectory, "state.json"))
			}
			if err == nil {
				var d *os.File
				d, err = os.Open(b.opts.StateDirectory)
				if err == nil {
					err = d.Sync()
					_ = d.Close()
				}
			}
		}
	}
	if err != nil {
		b.diskErr = fmt.Errorf("persist bridge state: %w", err)
	}
	b.wakeLocked()
}
func (b *Bridge) eventLocked(r *run, event string, fields Event) {
	if fields == nil {
		fields = Event{}
	}
	fields["event"] = event
	fields["run_id"] = r.ID
	fields["timestamp"] = float64(time.Now().UnixMilli()) / 1000
	raw, _ := json.Marshal(fields)
	if !strings.HasPrefix(event, "run.") && (len(raw) > 1024*1024-1024 || r.bytes+len(raw)+8 > 3*1024*1024 || len(r.Events) >= 9990) {
		b.failActiveLocked(r, "ACP event stream limit exceeded")
		return
	}
	if err := b.appendEvent(r, raw); err != nil {
		b.diskErr = err
		b.wakeLocked()
		return
	}
	r.Events = append(r.Events, fields)
	r.bytes += len(raw) + 8
	if strings.HasPrefix(event, "run.") || event == "approval.request" || event == "approval.responded" {
		b.saveLocked()
	} else {
		b.wakeLocked()
	}
}
func (b *Bridge) finishLocked(r *run, status, message string) {
	if terminal(r.Status) {
		return
	}
	r.Status = status
	r.TerminalAt = time.Now()
	if s := b.disk.Sessions[sessionKey(r.Profile, r.SessionID)]; s != nil && s.active == r.ID {
		s.LastUsed = r.TerminalAt
	}
	fields := Event{}
	if status == "completed" {
		fields["output"] = r.Output
	}
	if status == "failed" {
		fields["message"] = message
	}
	b.eventLocked(r, "run."+status, fields)
}

// Serve listens only on the validated loopback address. Closing the context
// shuts down HTTP streams and all owned agents.
func (b *Bridge) Serve(ctx context.Context) error {
	l, err := net.Listen("tcp", b.opts.ListenAddress)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: b, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: b.opts.Limits.BodyTimeout}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = b.Close()
			_ = srv.Close()
		case <-done:
		}
	}()
	err = srv.Serve(l)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func (b *Bridge) Close() error {
	b.mu.Lock()
	if b.closed {
		b.unlockAndSend()
		b.wg.Wait()
		return nil
	}
	b.closed = true
	for _, r := range b.disk.Runs {
		if !terminal(r.Status) {
			b.cancelPermissionsLocked(r)
			b.finishLocked(r, "interrupted", "bridge stopped")
		}
	}
	profiles := make([]*profile, 0, len(b.profiles))
	for _, p := range b.profiles {
		profiles = append(profiles, p)
	}
	b.unlockAndSend()
	b.cancel()
	for _, p := range profiles {
		p.mu.Lock()
		if p.idle != nil {
			p.idle.Stop()
		}
		if p.client != nil {
			p.client.stop()
		}
		p.mu.Unlock()
	}
	b.wg.Wait()
	<-b.maintenanceDone
	b.mu.Lock()
	defer b.unlockAndSend()
	return b.diskErr
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type sessionInput struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
type approvalInput struct {
	RequestID  string
	Generation int
	Choice     string
}

func (b *Bridge) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if subtle.ConstantTimeCompare([]byte(req.Header.Get("Authorization")), []byte("Bearer "+b.opts.Bearer)) != 1 {
		http.Error(w, "unauthorized", 401)
		return
	}
	parts := strings.Split(strings.TrimPrefix(req.URL.Path, "/"), "/")

	slug := ""
	path := req.URL.Path
	if len(parts) > 0 && parts[0] == "p" {
		if len(parts) < 3 || !slugPattern.MatchString(parts[1]) {
			http.NotFound(w, req)
			return
		}
		slug = parts[1]
		info, err := os.Lstat(filepath.Join(b.opts.ProfilesRoot, slug))
		if err != nil || !info.IsDir() {
			http.NotFound(w, req)
			return
		}
		path = "/" + strings.Join(parts[2:], "/")
	}

	if slug == "" && (strings.HasPrefix(path, "/api/sessions") || strings.HasPrefix(path, "/v1/runs")) {
		writeJSON(w, 400, map[string]any{"error": map[string]string{"code": "profile_required", "message": "ACP sessions and runs require a /p/<slug> profile prefix"}})
		return
	}
	// Consume and validate the entire body before entering shared state. This
	// also drains unexpected bodies on otherwise bodyless routes outside b.mu.
	var rawBody []byte
	if req.Body != nil {
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(b.opts.Limits.BodyTimeout))
		var err error
		rawBody, err = io.ReadAll(http.MaxBytesReader(w, req.Body, 4*1024*1024))
		if err == nil {
			_ = controller.SetReadDeadline(time.Time{})
		}
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				http.Error(w, "request body timeout", 408)
			} else {
				http.Error(w, "invalid request body", 400)
			}
			return
		}
	}
	var sessionBody sessionInput
	var runBody runInput
	var approvalBody approvalInput
	invalidApproval := false
	switch {
	case req.Method == "POST" && path == "/api/sessions":
		if json.Unmarshal(rawBody, &sessionBody) != nil || strings.TrimSpace(sessionBody.ID) == "" {
			http.Error(w, "invalid session body", 400)
			return
		}
	case req.Method == "POST" && path == "/v1/runs":
		if json.Unmarshal(rawBody, &runBody) != nil || strings.TrimSpace(runBody.SessionID) == "" {
			http.Error(w, "invalid run body", 400)
			return
		}
	case req.Method == "POST" && len(parts) == 6 && parts[2] == "v1" && parts[3] == "runs" && parts[5] == "approval":
		var body map[string]json.RawMessage
		if json.Unmarshal(rawBody, &body) != nil || len(body) != 3 || json.Unmarshal(body["request_id"], &approvalBody.RequestID) != nil || json.Unmarshal(body["execution_generation"], &approvalBody.Generation) != nil || json.Unmarshal(body["choice"], &approvalBody.Choice) != nil || approvalBody.RequestID == "" || len(approvalBody.RequestID) > 256 || approvalBody.Generation < 0 || approvalBody.Choice == "" {
			invalidApproval = true
		}
	}
	b.mu.Lock()
	defer b.unlockAndSend()
	if b.closed || b.diskErr != nil {
		http.Error(w, "bridge unavailable", 503)
		return
	}

	switch {
	case req.Method == "GET" && path == "/health":
		writeJSON(w, 200, map[string]bool{"ok": true})
	case req.Method == "GET" && path == "/v1/capabilities":
		writeJSON(w, 200, map[string]any{"features": map[string]bool{"run_steer": false}, "endpoints": map[string]any{"session_delete": map[string]string{"method": "DELETE", "path": "/api/sessions/{session_id}"}}, "max_concurrent_runs": b.opts.Limits.MaxConcurrentRuns})
	case req.Method == "GET" && path == "/v1/toolsets":
		writeJSON(w, 200, map[string]any{"data": []any{}})
	case req.Method == "GET" && path == "/api/model/options":
		writeJSON(w, 200, map[string]any{"provider": "acp", "model": "agent-default", "providers": []any{map[string]any{"slug": "acp", "name": "ACP agent default", "is_current": true, "authenticated": true, "models": []string{"agent-default"}}}})
	case req.Method == "POST" && path == "/api/sessions":
		body := sessionBody
		key := sessionKey(slug, body.ID)
		if s := b.disk.Sessions[key]; s != nil {
			s.LastUsed = time.Now()
			b.saveLocked()
			if b.diskErr != nil {
				http.Error(w, "persistence failed", 500)
				return
			}
			writeJSON(w, 409, map[string]string{"id": body.ID})
			return
		}
		b.disk.Sessions[key] = &session{Profile: slug, ID: body.ID, LastUsed: time.Now()}
		b.saveLocked()
		if b.diskErr != nil {
			http.Error(w, "persistence failed", 500)
			return
		}
		writeJSON(w, 201, map[string]string{"id": body.ID})
	case req.Method == "DELETE" && strings.HasPrefix(path, "/api/sessions/"):
		id := strings.TrimPrefix(path, "/api/sessions/")
		key := sessionKey(slug, id)
		s := b.disk.Sessions[key]
		if s == nil {
			http.NotFound(w, req)
			return
		}
		if s.active != "" {
			if r := b.disk.Runs[s.active]; r != nil {
				b.stopLocked(r)
			}
		}
		delete(b.disk.Sessions, key)
		b.saveLocked()
		if b.diskErr != nil {
			http.Error(w, "persistence failed", 500)
			return
		}
		w.WriteHeader(204)
	case req.Method == "POST" && path == "/v1/runs":
		b.createRunLocked(w, req, slug, runBody)
	case len(parts) >= 5 && parts[2] == "v1" && parts[3] == "runs":
		r := b.disk.Runs[parts[4]]
		if r == nil || r.Profile != slug {
			http.NotFound(w, req)
			return
		}
		action := ""
		if len(parts) == 6 {
			action = parts[5]
		} else if len(parts) != 5 {
			http.NotFound(w, req)
			return
		}
		switch {
		case req.Method == "GET" && action == "":
			writeJSON(w, 200, map[string]any{"run_id": r.ID, "status": r.Status, "output": r.Output, "execution_generation": r.Generation, "invalid_stdout_lines": r.InvalidLines, "unmatched_tool_completions": r.UnmatchedTools})
		case req.Method == "GET" && action == "events":
			b.streamLocked(w, req, r)
		case req.Method == "POST" && action == "stop":
			b.stopLocked(r)
			writeJSON(w, 200, map[string]bool{"ok": true})
		case req.Method == "POST" && action == "approval":
			if invalidApproval {
				http.Error(w, "invalid approval body", 400)
				return
			}
			b.approveLocked(w, r, approvalBody)
		default:
			http.NotFound(w, req)
		}
	default:
		http.NotFound(w, req)
	}
}

func (b *Bridge) agentEnvironment() []string {
	env := []string{}
	names := append([]string{"PATH", "HOME", "LANG", "TERM"}, b.opts.AgentEnvironment...)
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] || name == "" || strings.ContainsAny(name, "=\x00") {
			continue
		}
		seen[name] = true
		if value, ok := os.LookupEnv(name); ok && !strings.Contains(value, b.opts.Bearer) {
			env = append(env, name+"="+value)
		}
	}
	return env
}
