package operator

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// OAuthFlow is a running MCP OAuth authorization program
// (mcp_oauth_probe.py). Unlike a device-code login it needs one message
// back: the browser callback, delivered on its stdin.
type OAuthFlow interface {
	// Lines streams the program's stdout, one JSON event per line, and is
	// closed when the process ends.
	Lines() <-chan string
	// Wait blocks until the process ends and returns its failure, if any.
	Wait() error
	// Kill stops the process; Wait then returns.
	Kill()
	// Deliver writes one JSON line, the callback, to the program's stdin.
	Deliver(line []byte) error
}

// MCPOAuthSession is the wire shape of an MCP OAuth authorization.
//
// `authorizationUrl` is the provider's page the operator must open in a
// browser; the provider then redirects that browser to the openedbot
// callback named at start, which relays `code` and `state` back here. The
// session is `connected` only once upstream proved a token ON DISK and listed
// the server's tools with it, never on the callback alone.
//
// `profile` names whose home receives the token: a named profile, or null for
// the runtime root. A 409 `MCP_OAUTH_IN_PROGRESS` returns the pending session
// of the SERVER, which may be another profile's: the caller compares it with
// the profile it asked for before taking that session as its own.
type MCPOAuthSession struct {
	SessionID string  `json:"sessionId"`
	Server    string  `json:"server"`
	Profile   *string `json:"profile"`
	Status    string  `json:"status"`
	// CallbackReceived: the provider's callback for the current attempt was
	// relayed to the program, which is exchanging the code, listing the tools
	// and saving. Such a session is no longer cancelled (409
	// OAUTH_CALLBACK_RECEIVED): closing a page must not undo an approval.
	CallbackReceived bool     `json:"callbackReceived"`
	AuthorizationURL *string  `json:"authorizationUrl"`
	Error            *string  `json:"error"`
	ErrorCode        *string  `json:"errorCode"`
	DiscoveredTools  []string `json:"discoveredTools"`
	ExpiresAt        string   `json:"expiresAt"`
}

const (
	// MaxOAuthCallback bounds the code and state a callback may carry.
	MaxOAuthCallback = 4096
	// MaxRedirectURI bounds the callback URL openedbot registers.
	MaxRedirectURI = 2048
	// OAuthURLTimeout is how long the program may take to print the
	// authorization URL: discovery plus dynamic client registration.
	OAuthURLTimeout = 60 * time.Second
)

type mcpOAuthSession struct {
	id      string
	server  string
	profile string
	status  string
	url     string
	err     string
	errCode string
	tools   []string
	// usedState is the `state` of the last callback relayed to the program:
	// the same callback again is a replay, answered OAUTH_CALLBACK_USED.
	usedState string
	// callbackReceived: a code callback of the current attempt reached the
	// program (reset by the next attempt's URL).
	callbackReceived bool
	// saveLockLost: the program held the config lock past its bound, or its
	// context ended while holding it. Whatever it writes afterwards was not
	// serialised with the other writers: never reported as a success.
	saveLockLost bool
	startedAt    time.Time
	expiresAt    time.Time
	flow         OAuthFlow
	cancel       context.CancelFunc
}

type mcpOAuthStartBody struct {
	RedirectURI string `json:"redirectUri"`
	// Profile, when set, authorizes the server for that named profile: the
	// token lands in the profile's home, the only one its runs read.
	Profile string `json:"profile"`
}

type mcpOAuthCallbackBody struct {
	Code  string `json:"code"`
	State string `json:"state"`
	Error string `json:"error"`
	// Iss is the RFC 9207 issuer of the redirect, optional. A provider that
	// advertises it (Linear) has its authorization refused by the MCP SDK
	// when the callback drops it.
	Iss string `json:"iss"`
}

// probeEvent is one line of the authorization program's stdout.
type probeEvent struct {
	Event   string   `json:"event"`
	URL     string   `json:"url"`
	Tools   []string `json:"tools"`
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Text    string   `json:"text"`
}

// mcpOAuthRefusals is the closed set of codes the program may report, with
// the status each one takes on the wire. Anything else is reported as a
// generic failure, without its text.
var mcpOAuthRefusals = map[string]bool{
	"NAME_INVALID": true, "BODY_INVALID": true, "REDIRECT_INVALID": true,
	"SERVER_UNKNOWN": true, "SERVER_REFUSED": true, "OAUTH_UNSUPPORTED": true,
	"OAUTH_NO_TOKEN": true, "OAUTH_TIMEOUT": true, "OAUTH_CALLBACK_INVALID": true,
	"OAUTH_CANCELLED": true, "OAUTH_REGISTRATION_REFUSED": true, "OAUTH_FAILED": true,
	"PROFILE_INVALID": true, "PROFILE_NOT_FOUND": true,
}

func mcpServerName(w http.ResponseWriter, r *http.Request) (string, bool) {
	name := r.PathValue("name")
	if !mcpNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, "NAME_INVALID", "the server name is invalid")
		return "", false
	}
	return name, true
}

// validRedirectURI accepts an https callback, or a loopback http one: what a
// development openedbot behind an SSH tunnel presents. It is registered
// verbatim with the provider and never composed here.
func validRedirectURI(uri string) bool {
	if uri == "" || len(uri) > MaxRedirectURI || hasControl(uri) || strings.ContainsAny(uri, " \t") {
		return false
	}
	if strings.HasPrefix(uri, "https://") {
		return true
	}
	for _, loopback := range []string{"http://localhost:", "http://localhost/", "http://127.0.0.1:", "http://127.0.0.1/"} {
		if strings.HasPrefix(uri, loopback) {
			return true
		}
	}
	return false
}

// validAuthorizationURL is what the page may open: an https location of a
// bounded length, without control characters. Nothing else crosses.
func validAuthorizationURL(uri string) bool {
	return uri != "" && len(uri) <= MaxRedirectURI && !hasControl(uri) && strings.HasPrefix(uri, "https://")
}

func (s *Server) startMCPOAuth(w http.ResponseWriter, r *http.Request) {
	name, ok := mcpServerName(w, r)
	if !ok {
		return
	}
	var body mcpOAuthStartBody
	if !readBody(w, r, &body) {
		return
	}
	if !validRedirectURI(body.RedirectURI) {
		writeError(w, http.StatusBadRequest, "REDIRECT_INVALID", "the redirect URI must be https:// (or a loopback http:// origin)")
		return
	}
	if body.Profile != "" && (!profileSlugRe.MatchString(body.Profile) || body.Profile == "default") {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	if s.StartMCPOAuth == nil {
		writeError(w, http.StatusServiceUnavailable, "OAUTH_UNAVAILABLE", "MCP OAuth is not available on this host")
		return
	}
	s.mu.Lock()
	s.sweepMCPOAuthLocked()
	if s.mcpSessions == nil {
		s.mcpSessions = map[string]*mcpOAuthSession{}
	}
	// One authorization per SERVER at a time, whatever the profile: the
	// provider's callback is relayed by server name (callbackMCPOAuth), so two
	// pending ones would compete for it. The 409 names the profile of the one
	// in progress (MCPOAuthSession.Profile).
	for _, existing := range s.mcpSessions {
		if existing.server == name && (existing.status == StatusStarting || existing.status == StatusPending) {
			view := s.mcpOAuthViewLocked(existing)
			s.mu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":   map[string]string{"code": "MCP_OAUTH_IN_PROGRESS", "message": "an authorization is already pending for " + name},
				"session": view,
			})
			return
		}
	}
	now := s.now()
	ctx, cancel := context.WithTimeout(context.Background(), LoginTimeout)
	sess := &mcpOAuthSession{id: randomHex(16), server: name, profile: body.Profile, status: StatusStarting, startedAt: now, expiresAt: now.Add(SessionTTL), cancel: cancel}
	s.mcpSessions[sess.id] = sess
	s.mu.Unlock()

	flow, err := s.StartMCPOAuth(ctx, name, body.Profile, body.RedirectURI)
	if err != nil {
		cancel()
		s.mu.Lock()
		sess.status = StatusFailed
		sess.errCode = "OAUTH_FAILED"
		sess.err = "the authorization could not be started"
		view := s.mcpOAuthViewLocked(sess)
		s.mu.Unlock()
		s.logf("mcp oauth for %s could not start: %v", name, err)
		writeJSON(w, http.StatusOK, view)
		return
	}
	s.mu.Lock()
	sess.flow = flow
	s.mu.Unlock()
	go s.followMCPOAuth(ctx, sess)

	// The page needs the URL, not a session it would have to poll for it:
	// wait for the program to print it, bounded by discovery + registration.
	deadline := time.Now().Add(OAuthURLTimeout)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		settled := sess.status != StatusStarting
		s.mu.Unlock()
		if settled {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	s.mu.Lock()
	view := s.mcpOAuthViewLocked(sess)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, view)
}

// followMCPOAuth reads the program's events until it ends. The session is
// `connected` only on an `approved` event: the program emits it after
// upstream proved the token on disk and listed the tools with it.
func (s *Server) followMCPOAuth(ctx context.Context, sess *mcpOAuthSession) {
	terminal := false
	// The config lock the program asked for before saving, held until it
	// reports its verdict, ends, or overstays its bound.
	var hold *mcpOAuthConfigHold
	defer hold.release()
	for line := range sess.flow.Lines() {
		var event probeEvent
		if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &event); err != nil {
			continue
		}
		if event.Event == "diagnostic" {
			// For the journal only: the program's own account of what went
			// wrong, which never crosses the link.
			s.logf("mcp oauth %s: %s", sess.server, strings.Map(printable, event.Text))
			continue
		}
		if event.Event == "config_lock" {
			if hold == nil && !terminal {
				hold = s.grantMCPOAuthConfigLock(ctx, sess)
			}
			continue
		}
		if event.Event == "approved" || event.Event == "error" {
			hold.release()
		}
		diskChanged := false
		s.mu.Lock()
		switch {
		// Whatever the session became meanwhile (cancelled, expired), the
		// program saved the server and proved its token: the disk changed,
		// and the session says so, unless the save ran without the lock.
		case event.Event == "approved" && !terminal:
			terminal = true
			diskChanged = true
			if sess.saveLockLost {
				s.logf("mcp oauth %s: the program saved after losing the config lock", sess.server)
				break
			}
			sess.status = StatusConnected
			sess.errCode, sess.err = "", ""
			sess.tools = boundedNames(event.Tools)
		case sess.status == StatusCancelled:
		// EVERY authorization URL, not only the first: the MCP client retries
		// a connection whose callback did not arrive in time, and each attempt
		// carries a fresh `state`. The page must open the current one.
		case event.Event == "authorization_url" && (sess.status == StatusStarting || sess.status == StatusPending) && validAuthorizationURL(event.URL):
			sess.url, sess.status = event.URL, StatusPending
			sess.callbackReceived = false
		case event.Event == "error" && !terminal:
			terminal = true
			if sess.saveLockLost {
				break
			}
			sess.status = StatusFailed
			if mcpOAuthRefusals[event.Code] {
				sess.errCode, sess.err = event.Code, event.Message
			} else {
				sess.errCode, sess.err = "OAUTH_FAILED", "the host could not complete the authorization"
			}
		}
		s.mu.Unlock()
		if diskChanged {
			// The token is on disk and the server is on the platform: the
			// cached inventory is stale, and the gateway has not seen any of
			// it yet.
			s.dropReadCache()
			s.markMCPRestartPending()
			// The program saved a server into the profile: tool search follows
			// (profile_tool_search.go). The config lock was released above.
			if sess.profile != "" {
				_ = s.convergeToolSearch(context.WithoutCancel(ctx), []string{sess.profile})
			}
		}
	}
	hold.release()
	err := sess.flow.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess.status == StatusCancelled || terminal || sess.saveLockLost {
		return
	}
	sess.status = StatusFailed
	if ctx.Err() != nil {
		sess.errCode, sess.err = "OAUTH_TIMEOUT", "the authorization expired"
		return
	}
	sess.errCode = "OAUTH_FAILED"
	sess.err = "the authorization program ended without a result"
	if err != nil {
		s.logf("mcp oauth program for %s failed: %v", sess.server, err)
	}
}

// mcpOAuthConfigGrant is the line that tells the program it holds the lock.
var mcpOAuthConfigGrant = []byte(`{"configLock":"held"}` + "\n")

// mcpOAuthConfigLockHold bounds how long the program may keep the config lock
// once granted: one save of one file, seconds. A program stuck past it (a
// blocked filesystem, an upstream save that never returns) would otherwise
// block every capability or model change of that profile, and killing it may
// not work (the operator cannot always signal the interpreter, see
// mcpOAuthKillGrace). A variable so tests can shorten it.
var mcpOAuthConfigLockHold = time.Minute

// mcpOAuthConfigHold is a granted config lock, released exactly once: by the
// verdict, by the program's end, or by its bound.
type mcpOAuthConfigHold struct {
	once   sync.Once
	unlock func()
	done   chan struct{}
}

func (h *mcpOAuthConfigHold) release() {
	if h == nil {
		return
	}
	h.once.Do(func() {
		close(h.done)
		h.unlock()
	})
}

// grantMCPOAuthConfigLock takes the lock of the config.yaml the program is
// about to rewrite (the profile's, or the root's) and tells it so. The program
// asks only once the token is proven, right before its save: the lock covers
// that read-modify-write, never the minutes the person spends at the
// provider. Without it a capability or model toggle of the same profile,
// taken under the lock by the probe verbs, could interleave with the save and
// one of the two changes would be silently lost. nil when the lock was not
// granted: the session was cancelled, or its context ended first; the program
// then gives up its save on its own deadline or on EOF.
func (s *Server) grantMCPOAuthConfigLock(ctx context.Context, sess *mcpOAuthSession) *mcpOAuthConfigHold {
	s.mu.Lock()
	cancelled := sess.status == StatusCancelled
	s.mu.Unlock()
	if cancelled {
		return nil
	}
	key := sess.profile
	if key == "" {
		key = rootConfig
	}
	unlock, err := s.lockConfigs(ctx, key)
	if err != nil {
		s.logf("mcp oauth %s: the config lock was not granted: %v", sess.server, err)
		return nil
	}
	hold := &mcpOAuthConfigHold{unlock: unlock, done: make(chan struct{})}
	if err := sess.flow.Deliver(mcpOAuthConfigGrant); err != nil {
		hold.release()
		s.logf("mcp oauth %s: the config lock grant could not be delivered: %v", sess.server, err)
		return nil
	}
	// Its own goroutine: the one following the program is blocked reading
	// lines the stuck program no longer prints.
	go s.boundMCPOAuthConfigHold(ctx, sess, hold)
	return hold
}

// boundMCPOAuthConfigHold takes the lock back from a program that keeps it
// past mcpOAuthConfigLockHold, or whose authorization ends while it holds it
// (expiry). The session fails with OAUTH_SAVE_TIMEOUT and the program is
// stopped. What it may still write later is outside the lock: the session
// never turns `connected` for it (saveLockLost), though the disk may carry
// the server, and that late write may undo a concurrent change of the same
// file; the inventory read afterwards shows what is really there.
func (s *Server) boundMCPOAuthConfigHold(ctx context.Context, sess *mcpOAuthSession, hold *mcpOAuthConfigHold) {
	timer := time.NewTimer(mcpOAuthConfigLockHold)
	defer timer.Stop()
	select {
	case <-hold.done:
		return
	case <-timer.C:
	case <-ctx.Done():
	}
	s.mu.Lock()
	select {
	case <-hold.done:
		// The verdict arrived meanwhile: the lock was released in time.
		s.mu.Unlock()
		return
	default:
	}
	sess.saveLockLost = true
	if sess.status == StatusStarting || sess.status == StatusPending {
		sess.status = StatusFailed
		sess.errCode, sess.err = "OAUTH_SAVE_TIMEOUT", "the host could not save the authorization in time"
	}
	flow := sess.flow
	s.mu.Unlock()
	hold.release()
	s.logf("mcp oauth %s: the program held the config lock too long; lock taken back", sess.server)
	flow.Kill()
}

func printable(r rune) rune {
	if r < 0x20 || r == 0x7f {
		return ' '
	}
	return r
}

func boundedNames(names []string) []string {
	out := make([]string, 0, len(names))
	for _, name := range names {
		if name == "" || len(name) > 128 || hasControl(name) {
			continue
		}
		out = append(out, name)
		if len(out) == 256 {
			break
		}
	}
	return out
}

func (s *Server) lookupMCPOAuth(w http.ResponseWriter, r *http.Request) (*mcpOAuthSession, bool) {
	name, ok := mcpServerName(w, r)
	if !ok {
		return nil, false
	}
	id := r.PathValue("session")
	if !sessionRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "OAUTH_SESSION_NOT_FOUND", "this authorization no longer exists")
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepMCPOAuthLocked()
	sess := s.mcpSessions[id]
	if sess == nil || sess.server != name {
		writeError(w, http.StatusNotFound, "OAUTH_SESSION_NOT_FOUND", "this authorization no longer exists")
		return nil, false
	}
	return sess, true
}

func (s *Server) pollMCPOAuth(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.lookupMCPOAuth(w, r)
	if !ok {
		return
	}
	s.mu.Lock()
	view := s.mcpOAuthViewLocked(sess)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, view)
}

// callbackMCPOAuth relays the provider's redirect, `code` and `state`, to
// the pending authorization of this server. The program validates `state`
// against the one it generated; a mismatch fails the authorization closed.
// The route names the SERVER, not the session: the callback URL is registered
// with the provider before any session id exists.
func (s *Server) callbackMCPOAuth(w http.ResponseWriter, r *http.Request) {
	name, ok := mcpServerName(w, r)
	if !ok {
		return
	}
	var body mcpOAuthCallbackBody
	if !readBody(w, r, &body) {
		return
	}
	if len(body.Code) > MaxOAuthCallback || len(body.State) > MaxOAuthCallback || len(body.Error) > 200 ||
		len(body.Iss) > MaxOAuthCallback ||
		hasControl(body.Code) || hasControl(body.State) || hasControl(body.Error) || hasControl(body.Iss) ||
		(body.Code == "" && body.Error == "") {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the callback must carry a code and a state, or an error")
		return
	}
	s.mu.Lock()
	s.sweepMCPOAuthLocked()
	var sess *mcpOAuthSession
	replayed := false
	for _, existing := range s.mcpSessions {
		if existing.server != name {
			continue
		}
		if body.State != "" && existing.usedState != "" && sameSecret(existing.usedState, body.State) {
			replayed = true
		}
		if existing.status == StatusPending {
			sess = existing
		}
	}
	// A callback already relayed (a reloaded return page, a replayed link)
	// is refused for what it is, even once its authorization has ended,
	// rather than reported as received.
	if replayed {
		s.mu.Unlock()
		writeError(w, http.StatusConflict, "OAUTH_CALLBACK_USED", "this callback was already received")
		return
	}
	if sess == nil {
		s.mu.Unlock()
		writeError(w, http.StatusNotFound, "OAUTH_SESSION_NOT_FOUND", "no authorization is waiting for a callback for "+name)
		return
	}
	// The `state` the provider must echo is the one of the URL the page
	// opened, the latest one the program printed: each retried attempt
	// carries a fresh one and the program no longer accepts the previous
	// ones. Checked here so a stale or forged callback fails visibly instead
	// of being dropped by the program while the page says « received ». An
	// error callback is held to the same rule: without it, anyone who knows
	// the callback URL could fail a pending authorization.
	if expected := authorizationState(sess.url); expected != "" && !sameSecret(expected, body.State) {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "OAUTH_CALLBACK_INVALID", "the callback does not match the pending authorization")
		return
	}
	if body.State != "" {
		sess.usedState = body.State
	}
	if body.Code != "" {
		sess.callbackReceived = true
	}
	flow := sess.flow
	s.mu.Unlock()

	fields := map[string]string{"code": body.Code, "state": body.State, "error": body.Error}
	if body.Iss != "" {
		fields["iss"] = body.Iss
	}
	line, _ := json.Marshal(fields)
	if err := flow.Deliver(append(line, '\n')); err != nil {
		s.mu.Lock()
		if sess.status == StatusPending {
			sess.status = StatusFailed
			sess.errCode, sess.err = "OAUTH_FAILED", "the callback could not be delivered to the host"
		}
		view := s.mcpOAuthViewLocked(sess)
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, view)
		return
	}
	s.mu.Lock()
	view := s.mcpOAuthViewLocked(sess)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, view)
}

// authorizationState is the `state` parameter of an authorization URL, or ""
// when the URL carries none (the program then remains the only judge).
func authorizationState(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return parsed.Query().Get("state")
}

func sameSecret(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (s *Server) cancelMCPOAuth(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.lookupMCPOAuth(w, r)
	if !ok {
		return
	}
	s.mu.Lock()
	if (sess.status == StatusStarting || sess.status == StatusPending) && sess.callbackReceived {
		s.mu.Unlock()
		writeError(w, http.StatusConflict, "OAUTH_CALLBACK_RECEIVED", "the provider's callback was received; the host is completing the authorization")
		return
	}
	if sess.status == StatusStarting || sess.status == StatusPending {
		sess.status = StatusCancelled
		if sess.flow != nil {
			sess.flow.Kill()
		}
		sess.cancel()
	}
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) mcpOAuthViewLocked(sess *mcpOAuthSession) MCPOAuthSession {
	tools := sess.tools
	if tools == nil {
		tools = []string{}
	}
	return MCPOAuthSession{
		SessionID: sess.id, Server: sess.server, Profile: optional(sess.profile), Status: sess.status,
		CallbackReceived: sess.callbackReceived,
		AuthorizationURL: optional(sess.url), Error: optional(sess.err), ErrorCode: optional(sess.errCode),
		DiscoveredTools: tools,
		ExpiresAt:       sess.expiresAt.UTC().Format(time.RFC3339),
	}
}

// sweepMCPOAuthLocked expires authorizations exactly like provider sessions:
// a pending one past its TTL is killed and reported failed; terminal ones are
// forgotten after the same delay.
func (s *Server) sweepMCPOAuthLocked() {
	now := s.now()
	for id, sess := range s.mcpSessions {
		if now.Before(sess.expiresAt) {
			continue
		}
		if sess.status == StatusStarting || sess.status == StatusPending {
			sess.status = StatusFailed
			sess.errCode, sess.err = "OAUTH_TIMEOUT", "the authorization expired after 15 minutes"
			if sess.flow != nil {
				sess.flow.Kill()
			}
			sess.cancel()
			continue
		}
		if now.After(sess.expiresAt.Add(SessionTTL)) {
			delete(s.mcpSessions, id)
		}
	}
}

// pipeFlow adapts a process with a stdout pipe and a stdin pipe to OAuthFlow.
// Shared by the host flow and by tests.
type pipeFlow struct {
	lines chan string
	done  chan struct{}
	err   error
	stdin io.WriteCloser
	wait  func() error
	kill  func()
}

func newPipeFlow(stdout io.Reader, stdin io.WriteCloser, wait func() error, kill func()) *pipeFlow {
	f := &pipeFlow{lines: make(chan string, 64), done: make(chan struct{}), stdin: stdin, wait: wait, kill: kill}
	go f.pump(stdout)
	return f
}

func (f *pipeFlow) pump(out io.Reader) {
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 64<<10)
	for sc.Scan() {
		select {
		case f.lines <- sc.Text():
		default:
			select {
			case <-f.lines:
			default:
			}
			f.lines <- sc.Text()
		}
	}
	f.err = f.wait()
	close(f.lines)
	close(f.done)
}

func (f *pipeFlow) Lines() <-chan string { return f.lines }
func (f *pipeFlow) Wait() error          { <-f.done; return f.err }
func (f *pipeFlow) Kill()                { f.kill() }
func (f *pipeFlow) Deliver(line []byte) error {
	_, err := f.stdin.Write(line)
	return err
}
