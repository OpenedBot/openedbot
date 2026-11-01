package connector

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// The local audit of YOLO auto-approvals (docs/CONNECTOR.md, « Audit YOLO »).
// Every auto-approval is written here, and fsynced, BEFORE it takes effect: an
// approval this host cannot record does not happen, the gate goes to a human.
//
// yolo-pending.jsonl is the outbox: one entry per line, hash-chained,
// metadata and the hash of the arguments only. An entry is sealed into the
// creation audit (kind yolo_auto_approved) as soon as the link has armed it,
// or at the next audit.key; it is sent in yolo.audit frames and purged once
// openedbot acknowledges it (yolo.audit.ack) and, when the creation audit is
// enabled, once it is sealed.
const (
	yoloPendingFile    = "yolo-pending.jsonl"
	yoloAuditStateFile = "yolo-audit-state.json"
	yoloAuditGenesis   = "ohb-yolo-audit/v1/genesis"
	// yoloAuditMaxPending bounds the outbox: past it, auto-approvals stop
	// (they could not be recorded) until openedbot acknowledges.
	yoloAuditMaxPending = 4096
	// yoloAuditRecentIDs bounds the event ids kept after a purge so a record
	// delivered twice (the plugin spool) is not chained twice.
	yoloAuditRecentIDs = 512
	// Gate kinds of an entry.
	YoloGatePluginTool     = "plugin_tool"
	YoloGateTerminalDanger = "terminal_danger"
)

// ErrYoloAuditFull: the outbox is full, nothing more is auto-approved.
var ErrYoloAuditFull = errors.New("yolo audit outbox is full")

type yoloAuditState struct {
	Schema        int      `json:"schema"`
	RuntimeID     string   `json:"runtimeId"`
	BaseSeq       uint64   `json:"baseSeq"`
	BaseHash      string   `json:"baseHash"`
	AckedThrough  uint64   `json:"ackedThrough"`
	SealedThrough uint64   `json:"sealedThrough"`
	Recent        []string `json:"recent,omitempty"`
}

// yoloAuditBody is an entry without its own hash: what the chain covers.
type yoloAuditBody struct {
	Seq        uint64  `json:"seq"`
	EventID    string  `json:"eventId"`
	OccurredAt int64   `json:"occurredAt"`
	LeaseID    string  `json:"leaseId"`
	Profile    string  `json:"profile"`
	GateKind   string  `json:"gateKind"`
	ToolKey    *string `json:"toolKey"`
	ArgsHash   string  `json:"argsHash"`
	PrevHash   string  `json:"prevHash"`
}

// YoloEntryHash is entryHash = SHA-256(0x01 || canonical(entry without
// entryHash) || prevHash), the creation audit's chain rule.
func YoloEntryHash(e YoloAuditEntry) (string, error) {
	prev, err := hashFromHex(e.PrevHash)
	if err != nil {
		return "", err
	}
	canonical, err := canonicalJSON(yoloAuditBody{e.Seq, e.EventID, e.OccurredAt, e.LeaseID, e.Profile, e.GateKind, e.ToolKey, e.ArgsHash, e.PrevHash})
	if err != nil {
		return "", err
	}
	return hashHex(chainNext(prev, canonical)), nil
}

// YoloAuditGenesis is the prevHash of a runtime's first entry.
func YoloAuditGenesis(runtimeID string) string {
	return hashHex(sha256.Sum256([]byte(yoloAuditGenesis + runtimeID)))
}

// YoloArgsHash is the hash of a gate's arguments as the connector sees them.
func YoloArgsHash(text string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(text)))
}

// YoloAuditRecord is an auto-approval to record; the chain fields are the
// audit's. EventID may be empty (the audit draws one).
type YoloAuditRecord struct {
	EventID    string
	OccurredAt int64
	LeaseID    string
	Profile    string
	GateKind   string
	ToolKey    *string
	ArgsHash   string
}

// YoloAudit is the outbox of one runtime.
type YoloAudit struct {
	dir       string
	runtimeID string
	now       func() time.Time
	random    io.Reader

	mu      sync.Mutex
	state   yoloAuditState
	entries []YoloAuditEntry
	// sealer seals one entry into the creation audit; nil when the creation
	// audit is not enabled on this host.
	sealer func(YoloAuditEntry) error
	// sentThrough is the last seq sent on the current session.
	sentThrough uint64
}

// OpenYoloAudit loads the outbox and verifies its chain. A chain that does
// not verify is an error: the caller then auto-approves nothing.
func OpenYoloAudit(dir, runtimeID string, now func() time.Time) (*YoloAudit, error) {
	if runtimeID == "" {
		return nil, errors.New("yolo audit requires a runtime id")
	}
	if now == nil {
		now = time.Now
	}
	a := &YoloAudit{dir: dir, runtimeID: runtimeID, now: now, random: rand.Reader}
	present, err := readYoloJSON(filepath.Join(dir, yoloAuditStateFile), &a.state)
	if err != nil {
		return nil, err
	}
	if !present || a.state.RuntimeID != runtimeID {
		// An outbox without its state (or of a previous enrollment) cannot be
		// chained onto: it is kept aside for the operator, never deleted.
		if info, err := os.Stat(a.pendingPath()); err == nil && info.Size() > 0 {
			aside := filepath.Join(dir, fmt.Sprintf("yolo-pending.orphan-%d.jsonl", now().Unix()))
			if err := os.Rename(a.pendingPath(), aside); err != nil {
				return nil, err
			}
		}
		a.state = yoloAuditState{Schema: 1, RuntimeID: runtimeID, BaseHash: YoloAuditGenesis(runtimeID)}
		// The state exists before the first entry: an outbox is never found
		// without the base it chains from.
		if err := a.persistStateLocked(); err != nil {
			return nil, err
		}
	}
	if a.state.Schema != 1 {
		return nil, fmt.Errorf("%s has schema %d", yoloAuditStateFile, a.state.Schema)
	}
	entries, err := a.readPending()
	if err != nil {
		return nil, err
	}
	a.entries = entries
	a.sentThrough = a.state.AckedThrough
	return a, nil
}

func (a *YoloAudit) pendingPath() string { return filepath.Join(a.dir, yoloPendingFile) }

// readPending reads and verifies the outbox. A last line cut by a crash was
// never confirmed (nothing was approved on it) and is dropped.
func (a *YoloAudit) readPending() ([]YoloAuditEntry, error) {
	data, err := os.ReadFile(a.pendingPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	lines := bytes.Split(data, []byte("\n"))
	var entries []YoloAuditEntry
	prevSeq, prevHash := a.state.BaseSeq, a.state.BaseHash
	for i, line := range lines {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var e YoloAuditEntry
		if err := json.Unmarshal(line, &e); err != nil {
			if i == len(lines)-1 || (i == len(lines)-2 && len(bytes.TrimSpace(lines[len(lines)-1])) == 0) {
				// Rewrite without it, or the next append would glue onto it.
				if err := rewritePending(a.pendingPath(), entries); err != nil {
					return nil, err
				}
				break
			}
			return nil, fmt.Errorf("%w: %s line %d", ErrAuditChain, yoloPendingFile, i+1)
		}
		if e.Seq <= a.state.BaseSeq {
			// Already purged: the state was written, the outbox not yet.
			if e.Seq == a.state.BaseSeq && e.EntryHash != a.state.BaseHash {
				return nil, fmt.Errorf("%w: %s entry %d is not the base", ErrAuditChain, yoloPendingFile, e.Seq)
			}
			continue
		}
		want, err := YoloEntryHash(e)
		if err != nil || e.Seq != prevSeq+1 || e.PrevHash != prevHash || e.EntryHash != want {
			return nil, fmt.Errorf("%w: %s entry %d", ErrAuditChain, yoloPendingFile, e.Seq)
		}
		entries = append(entries, e)
		prevSeq, prevHash = e.Seq, e.EntryHash
	}
	return entries, nil
}

// SetSealer connects the creation audit; nil when it is not enabled.
func (a *YoloAudit) SetSealer(sealer func(YoloAuditEntry) error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sealer = sealer
}

func (a *YoloAudit) tailLocked() (uint64, string) {
	if n := len(a.entries); n > 0 {
		return a.entries[n-1].Seq, a.entries[n-1].EntryHash
	}
	return a.state.BaseSeq, a.state.BaseHash
}

func (a *YoloAudit) eventID() (string, error) {
	var id [16]byte
	if _, err := io.ReadFull(a.random, id[:]); err != nil {
		return "", err
	}
	id[6], id[8] = (id[6]&0x0f)|0x40, (id[8]&0x3f)|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

// Record chains one auto-approval and makes it durable before returning. An
// error means it was not recorded and must not take effect. A record whose
// event id is already chained is returned as it was, not chained twice.
func (a *YoloAudit) Record(r YoloAuditRecord) (YoloAuditEntry, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.EventID != "" {
		if i := slices.IndexFunc(a.entries, func(e YoloAuditEntry) bool { return e.EventID == r.EventID }); i >= 0 {
			return a.entries[i], nil
		}
		if slices.Contains(a.state.Recent, r.EventID) {
			return YoloAuditEntry{EventID: r.EventID}, nil
		}
	} else {
		id, err := a.eventID()
		if err != nil {
			return YoloAuditEntry{}, err
		}
		r.EventID = id
	}
	if !eventIDRe.MatchString(r.EventID) || !eventIDRe.MatchString(r.LeaseID) || !yoloProfileRe.MatchString(r.Profile) ||
		!yoloGateKindRe.MatchString(r.GateKind) || !yoloHex64Re.MatchString(r.ArgsHash) || (r.ToolKey != nil && (*r.ToolKey == "" || len(*r.ToolKey) > yoloMaxToolKey)) {
		return YoloAuditEntry{}, errors.New("yolo audit record is invalid")
	}
	if len(a.entries) >= yoloAuditMaxPending {
		return YoloAuditEntry{}, ErrYoloAuditFull
	}
	if r.OccurredAt == 0 {
		r.OccurredAt = a.now().Unix()
	}
	seq, prev := a.tailLocked()
	e := YoloAuditEntry{Seq: seq + 1, EventID: r.EventID, OccurredAt: r.OccurredAt, LeaseID: r.LeaseID, Profile: r.Profile,
		GateKind: r.GateKind, ToolKey: r.ToolKey, ArgsHash: r.ArgsHash, PrevHash: prev}
	hash, err := YoloEntryHash(e)
	if err != nil {
		return YoloAuditEntry{}, err
	}
	e.EntryHash = hash
	line, err := json.Marshal(e)
	if err != nil {
		return YoloAuditEntry{}, err
	}
	if err := appendDurably(a.pendingPath(), append(line, '\n')); err != nil {
		return YoloAuditEntry{}, err
	}
	a.entries = append(a.entries, e)
	a.sealLocked()
	return e, nil
}

func appendDurably(path string, line []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(line); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// Seal seals every entry the creation audit does not hold yet; called when
// the link arms it (audit.key).
func (a *YoloAudit) Seal() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sealLocked()
}

func (a *YoloAudit) sealLocked() {
	if a.sealer == nil {
		return
	}
	sealed := a.state.SealedThrough
	for _, e := range a.entries {
		if e.Seq <= sealed {
			continue
		}
		if err := a.sealer(e); err != nil {
			break // unarmed or failing: the entry stays pending
		}
		sealed = e.Seq
	}
	if sealed != a.state.SealedThrough {
		a.state.SealedThrough = sealed
		_ = a.persistStateLocked()
		a.purgeLocked()
	}
}

func (a *YoloAudit) persistStateLocked() error {
	data, err := json.MarshalIndent(a.state, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(filepath.Join(a.dir, yoloAuditStateFile), append(data, '\n'), 0o600, fsx.Current())
}

// StartSession forgets what the previous session sent: every entry not
// acknowledged goes out again (openedbot ingests on (runtimeId, seq)).
func (a *YoloAudit) StartSession() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sentThrough = a.state.AckedThrough
}

// NextBatch is the next contiguous slice to send, at most max entries; it
// is marked sent.
func (a *YoloAudit) NextBatch(max int) []YoloAuditEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []YoloAuditEntry
	for _, e := range a.entries {
		if e.Seq > a.sentThrough && len(out) < max {
			out = append(out, e)
		}
	}
	if len(out) > 0 {
		a.sentThrough = out[len(out)-1].Seq
	}
	return out
}

// Unsent rolls back a batch that could not be sent.
func (a *YoloAudit) Unsent(fromSeq uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if fromSeq > 0 && fromSeq-1 < a.sentThrough {
		a.sentThrough = fromSeq - 1
	}
}

// Ack records yolo.audit.ack and purges what may go.
func (a *YoloAudit) Ack(toSeq uint64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	last, _ := a.tailLocked()
	toSeq = min(toSeq, last)
	if toSeq <= a.state.AckedThrough {
		return nil
	}
	a.state.AckedThrough = toSeq
	if err := a.persistStateLocked(); err != nil {
		return err
	}
	a.purgeLocked()
	return nil
}

// purgeLocked drops what openedbot holds and, when the creation audit is
// enabled, what it seals. The chain continues from the last dropped entry.
func (a *YoloAudit) purgeLocked() {
	limit := a.state.AckedThrough
	if a.sealer != nil {
		limit = min(limit, a.state.SealedThrough)
	}
	cut := 0
	for cut < len(a.entries) && a.entries[cut].Seq <= limit {
		cut++
	}
	if cut == 0 {
		return
	}
	next := a.state
	next.BaseSeq, next.BaseHash = a.entries[cut-1].Seq, a.entries[cut-1].EntryHash
	for _, e := range a.entries[:cut] {
		next.Recent = append(next.Recent, e.EventID)
	}
	if len(next.Recent) > yoloAuditRecentIDs {
		next.Recent = next.Recent[len(next.Recent)-yoloAuditRecentIDs:]
	}
	// State first, outbox last: a crash in between leaves purged entries in
	// the outbox, at or under the new base, which readPending skips.
	previous := a.state
	a.state = next
	if err := a.persistStateLocked(); err != nil {
		a.state = previous
		return
	}
	if err := rewritePending(a.pendingPath(), a.entries[cut:]); err != nil {
		return
	}
	a.entries = slices.Clone(a.entries[cut:])
}

func rewritePending(path string, entries []YoloAuditEntry) error {
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	for _, e := range entries {
		line, err := json.Marshal(e)
		if err != nil {
			return err
		}
		_, _ = w.Write(append(line, '\n'))
	}
	if err := w.Flush(); err != nil {
		return err
	}
	return fsx.WriteAtomic(path, buf.Bytes(), 0o600, fsx.Current())
}

// Pending is how many entries the outbox holds.
func (a *YoloAudit) Pending() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.entries)
}

// Tail is the last seq and hash of the chain.
func (a *YoloAudit) Tail() (uint64, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.tailLocked()
}
