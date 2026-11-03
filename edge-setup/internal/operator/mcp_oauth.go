package operator

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
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
type MCPOAuthSession struct {
	SessionID        string   `json:"sessionId"`
	Server           string   `json:"server"`
	Status           string   `json:"status"`
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
	id        string
	server    string
	profile   string
	status    string
	url       string
	err       string
	errCode   string
	tools     []string
	startedAt time.Time
	expiresAt time.Time
	flow      OAuthFlow
	cancel    context.CancelFunc
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
		s.mu.Lock()
		switch {
		case sess.status == StatusCancelled:
		// EVERY authorization URL, not only the first: the MCP client retries
		// a connection whose callback did not arrive in time, and each attempt
		// carries a fresh `state`. The page must open the current one.
		case event.Event == "authorization_url" && (sess.status == StatusStarting || sess.status == StatusPending) && validAuthorizationURL(event.URL):
			sess.url, sess.status = event.URL, StatusPending
		case event.Event == "approved" && !terminal:
			terminal = true
			sess.status = StatusConnected
			sess.tools = boundedNames(event.Tools)
		case event.Event == "error" && !terminal:
			terminal = true
			sess.status = StatusFailed
			if mcpOAuthRefusals[event.Code] {
				sess.errCode, sess.err = event.Code, event.Message
			} else {
				sess.errCode, sess.err = "OAUTH_FAILED", "the host could not complete the authorization"
			}
		}
		connected := sess.status == StatusConnected
		s.mu.Unlock()
		if connected {
			// The token is on disk and the server is on the platform: the
			// cached inventory is stale, and the gateway has not seen any of
			// it yet.
			s.dropReadCache()
			s.markMCPRestartPending()
		}
	}
	err := sess.flow.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess.status == StatusCancelled || terminal {
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
	for _, existing := range s.mcpSessions {
		if existing.server == name && existing.status == StatusPending {
			sess = existing
			break
		}
	}
	if sess == nil {
		s.mu.Unlock()
		writeError(w, http.StatusNotFound, "OAUTH_SESSION_NOT_FOUND", "no authorization is waiting for a callback for "+name)
		return
	}
	// Several callbacks may reach a pending authorization: one from a
	// previous attempt's URL is rejected by the program (state mismatch) and
	// the flow keeps waiting, exactly like the Dashboard's callback route.
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

func (s *Server) cancelMCPOAuth(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.lookupMCPOAuth(w, r)
	if !ok {
		return
	}
	s.mu.Lock()
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
		SessionID: sess.id, Server: sess.server, Status: sess.status,
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
