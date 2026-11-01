package connector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/yolohardline"
	"github.com/coder/websocket"
)

// Yolo is the host side of YOLO mode, wired by the daemon (docs/CONNECTOR.md,
// « Bail YOLO »). Once a lease is accepted the host decides alone, link or no
// link:
//
//   - the approval plugin of each covered profile reads the yolo.json the
//     operator writes (Apply) on every tool call, checks the expiry itself
//     and lets a write pass after the hardline, deny-list and protections,
//     having first appended it to its own spool;
//   - a native terminal approval of a covered run is answered here, on the
//     loopback gateway (Approve), after the same checks and after the audit
//     entry is durable;
//   - the plugin spool is collected (Drain) into the local audit, which is
//     sealed and sent to openedbot when the link is up.
//
// Hermes' approvals.mode is never touched: it stays manual (SecurityDefaults).
type Yolo struct {
	Store *YoloStore
	Audit *YoloAudit
	// Apply writes the per-profile yolo.json of exactly these leases, and
	// removes it where none applies. nil: nothing is enforced in the plugin.
	Apply func(ctx context.Context, active []YoloLease) error
	// Drain reads the plugin spools; Drained acknowledges what was recorded.
	Drain   func(ctx context.Context) ([]YoloSpoolRecord, error)
	Drained func(ctx context.Context) error
	// Approve answers one native gate "once" on the loopback gateway.
	Approve func(ctx context.Context, profilePrefix, runID, requestID string) error
	Logf    func(string, ...any)
	// Tick is the period of the enforcement loop (kill file, expiry, spool).
	Tick time.Duration

	mu      sync.Mutex
	send    sender
	runs    map[string]yoloRun
	order   []string
	applied string
	lastAt  time.Time
	state   string
	wake    chan struct{}
}

// YoloSpoolRecord is one auto-approval the plugin of a profile recorded.
type YoloSpoolRecord struct {
	Profile    string  `json:"profile"`
	EventID    string  `json:"eventId"`
	OccurredAt int64   `json:"occurredAt"`
	LeaseID    string  `json:"leaseId"`
	GateKind   string  `json:"gateKind"`
	ToolKey    *string `json:"toolKey"`
	ArgsHash   string  `json:"argsHash"`
}

type yoloRun struct {
	profile    string
	sessionKey string
}

const (
	yoloMaxRuns        = 4096
	yoloReapplyEvery   = time.Minute
	yoloAuditBatch     = 64
	yoloDefaultTick    = 2 * time.Second
	yoloApproveTimeout = 10 * time.Second
)

func (y *Yolo) logf(format string, args ...any) {
	if y.Logf != nil {
		y.Logf(format, args...)
	}
}

func (y *Yolo) init() {
	y.mu.Lock()
	defer y.mu.Unlock()
	if y.wake == nil {
		y.wake = make(chan struct{}, 1)
		y.runs = map[string]yoloRun{}
	}
}

// poke asks the loop for a pass now.
func (y *Yolo) poke() {
	y.init()
	select {
	case y.wake <- struct{}{}:
	default:
	}
}

// Features is what the host announces: both, since a hook that receives
// session_id and runs the connector dispatched make a thread lease
// enforceable here.
func (y *Yolo) Features() []string {
	return []string{FeatureYoloLease, FeatureYoloThreadScope}
}

// SessionKey is how a lease names a Hermes session: hex(sha256(session_id)).
func SessionKey(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:])
}

// NoteRun remembers which profile and session a dispatched run belongs to.
func (y *Yolo) NoteRun(runID, profilePrefix, sessionID string) {
	y.init()
	y.mu.Lock()
	defer y.mu.Unlock()
	if _, known := y.runs[runID]; !known {
		y.order = append(y.order, runID)
		if len(y.order) > yoloMaxRuns {
			delete(y.runs, y.order[0])
			y.order = y.order[1:]
		}
	}
	y.runs[runID] = yoloRun{profile: profileSlug(profilePrefix), sessionKey: SessionKey(sessionID)}
}

func (y *Yolo) run(runID, profilePrefix string) yoloRun {
	y.init()
	y.mu.Lock()
	defer y.mu.Unlock()
	if r, ok := y.runs[runID]; ok {
		return r
	}
	return yoloRun{profile: profileSlug(profilePrefix)}
}

// profileSlug turns the /p/<slug> prefix into the slug, "default" without one.
func profileSlug(prefix string) string {
	slug := strings.TrimPrefix(strings.Trim(prefix, "/"), "p/")
	if slug == "" {
		return "default"
	}
	return slug
}

// Attach binds the session that can carry yolo.state and yolo.audit; the
// returned function detaches it.
func (y *Yolo) Attach(send sender) func() {
	y.init()
	y.Audit.StartSession()
	y.mu.Lock()
	y.send = send
	y.state = ""
	y.mu.Unlock()
	y.poke()
	return func() {
		y.mu.Lock()
		y.send = nil
		y.mu.Unlock()
	}
}

// OnFrame handles the yolo.* frames openedbot sends.
func (y *Yolo) OnFrame(f Text) {
	switch f.T {
	case TYoloLease:
		if err := y.Store.Accept(f.Yolo); err != nil {
			y.logf("yolo lease %s refused: %v", f.Yolo.Lease.LeaseID, err)
		} else {
			y.logf("yolo lease %s accepted (%s, until %s)", f.Yolo.Lease.LeaseID, f.Yolo.Lease.Scope, time.Unix(f.Yolo.Lease.ExpiresAt, 0).UTC().Format(time.RFC3339))
		}
	case TYoloRevoke:
		if err := y.Store.Revoke(f.Yolo); err != nil {
			y.logf("yolo revocation could not be persisted: %v; it holds in memory", err)
		}
	case TYoloAuditAck:
		if err := y.Audit.Ack(f.Yolo.ToSeq); err != nil {
			y.logf("yolo audit acknowledgment could not be persisted: %v", err)
		}
	}
	y.poke()
}

// PinKeys applies link.context leaseKeys.
func (y *Yolo) PinKeys(keys []YoloLeaseKey) {
	if len(keys) == 0 {
		return
	}
	if err := y.Store.PinKeys(keys); err != nil {
		y.logf("yolo: %v", err)
	}
}

// Run is the enforcement loop: it applies the active set whenever it changes
// (a lease, a revocation, an expiry, `yolo off`), re-applies it every minute
// so a new profile gets its file, collects the plugin spools, and reports.
func (y *Yolo) Run(ctx context.Context) {
	y.init()
	y.Store.SetOnChange(y.poke)
	tick := y.Tick
	if tick <= 0 {
		tick = yoloDefaultTick
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		y.pass(ctx)
		select {
		case <-ctx.Done():
			// What is applied stays: the plugin checks every expiry itself.
			return
		case <-t.C:
		case <-y.wake:
		}
	}
}

func leaseSetKey(active []YoloLease) string {
	ids := make([]string, 0, len(active))
	for _, l := range active {
		ids = append(ids, l.LeaseID)
	}
	slices.Sort(ids)
	return strings.Join(ids, ",")
}

func (y *Yolo) pass(ctx context.Context) {
	active := y.Store.Active()
	key := leaseSetKey(active)
	y.mu.Lock()
	due := key != y.applied || time.Since(y.lastAt) >= yoloReapplyEvery
	y.mu.Unlock()
	if due && y.Apply != nil {
		actx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := y.Apply(actx, active)
		cancel()
		y.mu.Lock()
		if err != nil {
			// The plugin falls back to asking while no file is there; retry
			// on the next pass.
			y.applied = "\x00unapplied"
			y.logf("yolo leases could not be applied to the profiles: %v", err)
		} else {
			y.applied, y.lastAt = key, time.Now()
		}
		y.mu.Unlock()
	}
	y.collect(ctx)
	y.report()
}

// collect moves the plugin spools into the local audit.
func (y *Yolo) collect(ctx context.Context) {
	if y.Drain == nil {
		return
	}
	dctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	records, err := y.Drain(dctx)
	if err != nil {
		y.logf("yolo plugin audit could not be collected: %v", err)
		return
	}
	if len(records) == 0 {
		return
	}
	for _, r := range records {
		if _, err := y.Audit.Record(YoloAuditRecord{EventID: r.EventID, OccurredAt: r.OccurredAt, LeaseID: r.LeaseID, Profile: r.Profile, GateKind: r.GateKind, ToolKey: r.ToolKey, ArgsHash: r.ArgsHash}); err != nil {
			// Keep the spool: the next pass retries the whole drain, and the
			// records already chained are recognized by their event id.
			y.logf("yolo plugin audit record %s could not be chained: %v", r.EventID, err)
			return
		}
	}
	if y.Drained != nil {
		if err := y.Drained(dctx); err != nil {
			y.logf("yolo plugin audit could not be acknowledged to the operator: %v", err)
		}
	}
}

// report sends yolo.state when it changed and the audit not yet sent.
func (y *Yolo) report() {
	y.mu.Lock()
	send := y.send
	y.mu.Unlock()
	if send == nil {
		return
	}
	leases, killedAt := y.Store.State()
	frame, err := EncodeYoloState(leases, killedAt)
	if err == nil {
		y.mu.Lock()
		changed := string(frame) != y.state
		y.mu.Unlock()
		if changed {
			if err := send(websocket.MessageText, frame); err != nil {
				return
			}
			y.mu.Lock()
			y.state = string(frame)
			y.mu.Unlock()
		}
	}
	for {
		batch := y.Audit.NextBatch(yoloAuditBatch)
		if len(batch) == 0 {
			return
		}
		frame, err := EncodeYoloAudit(y.Store.runtimeID, batch)
		if err == nil {
			err = send(websocket.MessageText, frame)
		}
		if err != nil {
			y.Audit.Unsent(batch[0].Seq)
			return
		}
	}
}

// approvalRequest is what the connector reads of a native approval event.
type approvalRequest struct {
	Event      string   `json:"event"`
	Command    string   `json:"command"`
	PatternKey string   `json:"pattern_key"`
	RequestID  string   `json:"request_id"`
	Choices    []string `json:"choices"`
}

// Observe looks at one journaled event of a run. A native terminal approval
// of a run a lease covers is answered "once" when the hardline, the
// deny-list and the protections let it pass and the audit entry is durable.
// Anything else (a plugin gate, a hit, no "once" choice, an audit that cannot
// be written) is left to the normal path: openedbot, then a human.
func (y *Yolo) Observe(ctx context.Context, runID, profilePrefix, block string) {
	request, ok := parseApprovalRequest(block)
	if !ok || strings.HasPrefix(request.PatternKey, "plugin_rule:") || !slices.Contains(request.Choices, "once") || request.Command == "" {
		return
	}
	run := y.run(runID, profilePrefix)
	lease := y.Store.Lookup(run.profile, run.sessionKey)
	if lease == nil {
		return
	}
	if verdict := blockVerdict(request.Command, *lease); verdict != "" {
		y.logf("yolo: terminal gate of run %s left to a human (%s)", runID, verdict)
		return
	}
	if _, err := y.Audit.Record(YoloAuditRecord{LeaseID: lease.LeaseID, Profile: run.profile, GateKind: YoloGateTerminalDanger, ArgsHash: YoloArgsHash(request.Command)}); err != nil {
		y.logf("yolo: terminal gate of run %s left to a human: the audit could not be written (%v)", runID, err)
		return
	}
	if y.Approve == nil {
		return
	}
	actx, cancel := context.WithTimeout(ctx, yoloApproveTimeout)
	defer cancel()
	if err := y.Approve(actx, profilePrefix, runID, request.RequestID); err != nil {
		// A human may have answered first (409): the entry stays, it records
		// that the host decided to approve.
		y.logf("yolo: terminal gate of run %s not answered: %v", runID, err)
		return
	}
	y.poke()
}

// blockVerdict is the shared hardline, the lease deny-list and protections
// applied to a terminal command; "" lets it pass.
func blockVerdict(command string, lease YoloLease) string {
	return yolohardline.Block(yolohardline.Subject{Command: command, HasCommand: true}, lease.Protect, lease.Deny)
}

func jsonUnmarshalString(text string, into any) error {
	return json.Unmarshal([]byte(text), into)
}

func parseApprovalRequest(block string) (approvalRequest, bool) {
	var event string
	var data []string
	for _, line := range strings.Split(block, "\n") {
		if value, ok := strings.CutPrefix(line, "event:"); ok {
			event = strings.TrimSpace(value)
		}
		if value, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(data, strings.TrimPrefix(value, " "))
		}
	}
	if event != "" && event != "message" && event != "approval.request" {
		return approvalRequest{}, false
	}
	var request approvalRequest
	if err := jsonUnmarshalString(strings.Join(data, "\n"), &request); err != nil {
		return approvalRequest{}, false
	}
	if event == "" || event == "message" {
		event = request.Event
	}
	return request, event == "approval.request"
}
