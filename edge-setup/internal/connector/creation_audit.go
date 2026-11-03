package connector

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const CreationAuditLimit = 4096
const creationAuditFileLimit = 8 << 20
const creationAuditResponseLimit = 64 << 10

// Names inside the runtime-bound audit directory. The v1 plaintext file is
// never read as evidence: a connector that finds one renames it aside so an
// operator can still look at it, and starts a v2 chain at genesis.
const (
	creationAuditFile   = "snapshot.bin"
	creationAuditV1File = "snapshot.json"
	creationAuditV1Kept = "snapshot.v1.json"
)

// CreationAuditEvent records metadata only, never request/response bodies or raw headers.
// An attempt means Do is about to run; a crash between its fsync and Do is deliberately
// indistinguishable from an uncertain dispatch. Counting it conservatively prevents
// a verifier from mistaking incomplete evidence for an exactly-once guarantee.
type CreationAuditEvent struct {
	EventID            string `json:"eventId"`
	AttemptID          string `json:"attemptId"`
	Phase              string `json:"phase"`
	OccurredAt         string `json:"occurredAt"`
	RuntimeID          string `json:"runtimeId"`
	Profile            string `json:"profile"`
	CorrelationID      string `json:"correlationId"`
	IdempotencyKeyHash string `json:"idempotencyKeyHash"`
	Method             string `json:"method"`
	Path               string `json:"path"`
	Status             int    `json:"status,omitempty"`
	RemoteID           string `json:"remoteId,omitempty"`
	Outcome            string `json:"outcome,omitempty"`
	// An auto-approval under a YOLO lease (kind yolo_auto_approved, phase
	// "decision"): additive, schemaVersion stays 2, and a run event leaves
	// these fields out. ArgsHash is the hash of the arguments, never them.
	Kind     string `json:"kind,omitempty"`
	LeaseID  string `json:"leaseId,omitempty"`
	ToolKey  string `json:"toolKey,omitempty"`
	GateKind string `json:"gateKind,omitempty"`
	ArgsHash string `json:"argsHash,omitempty"`
}

// CreationAuditKindYolo marks an auto-approval sealed from the YOLO audit.
const CreationAuditKindYolo = "yolo_auto_approved"

// SealYolo seals one YOLO auto-approval (YoloAudit.SetSealer).
func (a *CreationAudit) SealYolo(entry YoloAuditEntry) error { return a.appendYolo(entry) }

// appendYolo seals one YOLO auto-approval. ErrAuditKeyMissing while the link
// has not armed the file: the entry stays pending in yolo-pending.jsonl.
func (a *CreationAudit) appendYolo(entry YoloAuditEntry) error {
	toolKey := ""
	if entry.ToolKey != nil {
		toolKey = *entry.ToolKey
	}
	return a.append(CreationAuditEvent{
		EventID: entry.EventID, AttemptID: entry.EventID, Phase: "decision",
		OccurredAt: time.Unix(entry.OccurredAt, 0).UTC().Format(time.RFC3339Nano), RuntimeID: a.runtimeID, Profile: entry.Profile,
		Kind: CreationAuditKindYolo, LeaseID: entry.LeaseID, ToolKey: toolKey, GateKind: entry.GateKind, ArgsHash: entry.ArgsHash,
	})
}

// CreationAuditSnapshot is the plaintext of snapshot.bin. Base is the chain
// hash before the first retained event (genesis, or the hash of the last
// dropped event); Tail is the hash after the last one. WriteSeq counts
// persisted writes under this runtime and is repeated in the clear header.
type CreationAuditSnapshot struct {
	SchemaVersion int                  `json:"schemaVersion"`
	StartedAt     string               `json:"startedAt"`
	LastWrittenAt string               `json:"lastWrittenAt"`
	RuntimeID     string               `json:"runtimeId"`
	WriteSeq      uint64               `json:"writeSeq"`
	Count         int                  `json:"count"`
	Dropped       uint64               `json:"dropped"`
	Base          string               `json:"base"`
	Tail          string               `json:"tail"`
	Events        []CreationAuditEvent `json:"events"`
}

// AuditAnchor is what the connector tells openedbot after every write,
// so a verifier can tell a current export from a restored older copy.
type AuditAnchor struct {
	KeyID    string
	WriteSeq uint64
	Count    int
	Dropped  uint64
	Tail     string
}

// CreationAudit is opt-in, local-only evidence. The runtime+broker binding prevents
// enrollment into another organization from reusing this file. Reopening starts a
// new coverage window; retained older events do not assert continuous enablement.
//
// The audit is created unarmed: nothing is read or written until the link
// delivers the master key (audit.key). Without a key a creation is refused,
// never dispatched unaudited and never written in the clear.
type CreationAudit struct {
	mu        sync.Mutex
	dir       string
	path      string
	runtimeID string
	state     CreationAuditSnapshot
	lock      *os.File
	closed    bool
	armed     bool
	keyID     string
	key       []byte            // derived encryption key of keyID
	previous  map[string][]byte // derived keys still accepted for reading
	random    io.Reader
	now       func() time.Time
	anchors   func(AuditAnchor)
}

func NewCreationAudit(dir, runtimeID, wsURL string) (*CreationAudit, error) {
	if runtimeID == "" || wsURL == "" {
		return nil, errors.New("creation audit requires a runtime binding")
	}
	binding := sha256.Sum256([]byte(wsURL + "\n" + runtimeID))
	dir = filepath.Join(dir, fmt.Sprintf("%x", binding))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "writer.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, errors.New("creation audit already has a writer")
	}
	if err := setAsidePlaintextAudit(dir); err != nil {
		_ = lock.Close()
		return nil, err
	}
	return &CreationAudit{
		dir: dir, path: filepath.Join(dir, creationAuditFile), runtimeID: runtimeID, lock: lock,
		random: rand.Reader, now: time.Now, anchors: func(AuditAnchor) {},
	}, nil
}

// setAsidePlaintextAudit keeps a v1 file for the operator and out of the way.
func setAsidePlaintextAudit(dir string) error {
	v1 := filepath.Join(dir, creationAuditV1File)
	if _, err := os.Lstat(v1); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	kept := filepath.Join(dir, creationAuditV1Kept)
	if _, err := os.Lstat(kept); err == nil {
		kept = filepath.Join(dir, fmt.Sprintf("snapshot.v1.%d.json", time.Now().UTC().Unix()))
	}
	return os.Rename(v1, kept)
}

// Armed reports whether a key has been provisioned for this session.
func (a *CreationAudit) Armed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.armed
}

// Arm installs the master key openedbot provisioned (plus keys it still
// accepts for reading), opens the existing file with whichever of them its
// header names, verifies the chain, and reseals under the current key. A file
// sealed under a key that is neither current nor previous is a refusal, not a
// fresh start: evidence is never silently discarded.
func (a *CreationAudit) Arm(keyID string, master []byte, previous map[string][]byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return errors.New("creation audit is closed")
	}
	if keyID == "" {
		return errors.New("creation audit key requires an id")
	}
	key, err := deriveAuditKey(master, a.runtimeID)
	if err != nil {
		return err
	}
	accepted := map[string][]byte{keyID: key}
	for id, prior := range previous {
		derived, err := deriveAuditKey(prior, a.runtimeID)
		if err != nil {
			return err
		}
		accepted[id] = derived
	}
	state, header, err := a.readSealed(accepted)
	switch {
	case err == nil:
		if state.RuntimeID != a.runtimeID {
			return errors.New("creation audit binding mismatch")
		}
		if header.WriteSeq != state.WriteSeq {
			return fmt.Errorf("%w: header writeSeq %d, plaintext %d", ErrAuditFormat, header.WriteSeq, state.WriteSeq)
		}
		if err := verifyCreationAuditChain(state); err != nil {
			return err
		}
		a.state = state
	case errors.Is(err, os.ErrNotExist):
		genesis := hashHex(auditGenesis(a.runtimeID))
		a.state = CreationAuditSnapshot{SchemaVersion: auditSchemaVersion, RuntimeID: a.runtimeID, Base: genesis, Tail: genesis, Events: []CreationAuditEvent{}}
	default:
		return err
	}
	a.keyID, a.key, a.previous = keyID, key, accepted
	a.armed = true
	a.state.StartedAt = a.now().UTC().Format(time.RFC3339Nano)
	if err := a.persist(); err != nil {
		a.armed = false
		return err
	}
	return nil
}

// SetAnchorSink receives every anchor after its write is durable. The sink
// must not block: it runs under the audit lock so anchors stay ordered.
func (a *CreationAudit) SetAnchorSink(sink func(AuditAnchor)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if sink == nil {
		sink = func(AuditAnchor) {}
	}
	a.anchors = sink
}

// Anchor is the current chain position, resent when a session opens.
func (a *CreationAudit) Anchor() (AuditAnchor, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.armed {
		return AuditAnchor{}, false
	}
	return a.anchor(), true
}

func (a *CreationAudit) anchor() AuditAnchor {
	return AuditAnchor{KeyID: a.keyID, WriteSeq: a.state.WriteSeq, Count: a.state.Count, Dropped: a.state.Dropped, Tail: a.state.Tail}
}

// Close releases the exclusive writer lease after pending writes finish.
func (a *CreationAudit) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil
	}
	a.closed = true
	a.armed = false
	return a.lock.Close()
}

func readAuditFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, creationAuditFileLimit+auditMaxHeader+64))
	if err != nil {
		return nil, err
	}
	if len(data) > creationAuditFileLimit+auditMaxHeader+40 {
		return nil, errors.New("invalid or oversized creation audit")
	}
	return data, nil
}

func (a *CreationAudit) readSealed(derived map[string][]byte) (CreationAuditSnapshot, auditHeader, error) {
	data, err := readAuditFile(a.path)
	if err != nil {
		return CreationAuditSnapshot{}, auditHeader{}, err
	}
	hdr, at, err := parseAuditHeader(data)
	if err != nil {
		return CreationAuditSnapshot{}, hdr, err
	}
	key, ok := derived[hdr.KeyID]
	if !ok {
		return CreationAuditSnapshot{}, hdr, fmt.Errorf("%w: %s", ErrAuditKeyUnknown, hdr.KeyID)
	}
	aead, err := newAuditAEAD(key)
	if err != nil {
		return CreationAuditSnapshot{}, hdr, err
	}
	plaintext, err := aead.Open(nil, data[at:at+auditNonceSize], data[at+auditNonceSize:], data[:at+auditNonceSize])
	if err != nil {
		return CreationAuditSnapshot{}, hdr, ErrAuditAuth
	}
	state, err := decodeCreationAuditSnapshot(plaintext)
	return state, hdr, err
}

func decodeCreationAuditSnapshot(plaintext []byte) (CreationAuditSnapshot, error) {
	var state CreationAuditSnapshot
	if json.Unmarshal(plaintext, &state) != nil || state.SchemaVersion != auditSchemaVersion || len(state.Events) > CreationAuditLimit {
		return state, fmt.Errorf("%w: plaintext", ErrAuditFormat)
	}
	return state, nil
}

// OpenCreationAudit reads a sealed file with the master key its header
// names, verifies the chain and returns the plaintext. It is what a verifier
// does; the connector itself never exports.
func OpenCreationAudit(path string, keyFor func(keyID string) ([]byte, bool)) (CreationAuditSnapshot, error) {
	data, err := readAuditFile(path)
	if err != nil {
		return CreationAuditSnapshot{}, err
	}
	hdr, plaintext, err := openSnapshot(data, keyFor)
	if err != nil {
		return CreationAuditSnapshot{}, err
	}
	state, err := decodeCreationAuditSnapshot(plaintext)
	if err != nil {
		return state, err
	}
	if state.RuntimeID != hdr.RuntimeID || state.WriteSeq != hdr.WriteSeq {
		return state, fmt.Errorf("%w: header and plaintext disagree", ErrAuditFormat)
	}
	return state, verifyCreationAuditChain(state)
}

// ReadCreationAuditHeader exposes the clear header (key id, runtime, write
// sequence) so an export can be labelled without any key.
func ReadCreationAuditHeader(path string) (keyID, runtimeID string, writeSeq uint64, err error) {
	data, err := readAuditFile(path)
	if err != nil {
		return "", "", 0, err
	}
	hdr, _, err := parseAuditHeader(data)
	if err != nil {
		return "", "", 0, err
	}
	return hdr.KeyID, hdr.RuntimeID, hdr.WriteSeq, nil
}

// verifyCreationAuditChain recomputes base -> tail over the retained events.
func verifyCreationAuditChain(state CreationAuditSnapshot) error {
	if state.Count != len(state.Events) {
		return fmt.Errorf("%w: count %d for %d events", ErrAuditChain, state.Count, len(state.Events))
	}
	h, err := hashFromHex(state.Base)
	if err != nil {
		return err
	}
	if state.Dropped == 0 && h != auditGenesis(state.RuntimeID) {
		return fmt.Errorf("%w: base is not genesis", ErrAuditChain)
	}
	for _, event := range state.Events {
		canonical, err := canonicalJSON(event)
		if err != nil {
			return err
		}
		h = chainNext(h, canonical)
	}
	if hashHex(h) != state.Tail {
		return fmt.Errorf("%w: tail mismatch", ErrAuditChain)
	}
	return nil
}

func (a *CreationAudit) persist() error {
	a.state.LastWrittenAt = a.now().UTC().Format(time.RFC3339Nano)
	a.state.WriteSeq++
	a.state.Count = len(a.state.Events)
	plaintext, err := canonicalJSON(a.state)
	if err != nil {
		return err
	}
	if len(plaintext) > creationAuditFileLimit {
		return errors.New("creation audit exceeds file limit")
	}
	hdr := auditHeader{KeyID: a.keyID, RuntimeID: a.runtimeID, SchemaVersion: auditSchemaVersion, WriteSeq: a.state.WriteSeq}
	sealed, err := sealSnapshot(hdr, plaintext, a.key, a.random)
	if err != nil {
		return err
	}
	if err := fsx.WriteAtomic(a.path, sealed, 0o600, fsx.Current()); err != nil {
		return err
	}
	// fsx syncs the new file; sync its parent too so rename survives a host crash.
	dir, err := os.Open(filepath.Dir(a.path))
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return err
	}
	a.anchors(a.anchor())
	return nil
}

func (a *CreationAudit) auditUUID() (string, error) {
	var id [16]byte
	if _, err := io.ReadFull(a.random, id[:]); err != nil {
		return "", err
	}
	id[6], id[8] = (id[6]&0x0f)|0x40, (id[8]&0x3f)|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

func (a *CreationAudit) append(event CreationAuditEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return errors.New("creation audit is closed")
	}
	if !a.armed {
		return ErrAuditKeyMissing
	}
	canonical, err := canonicalJSON(event)
	if err != nil {
		return err
	}
	previous := a.state
	tail, err := hashFromHex(a.state.Tail)
	if err != nil {
		return err
	}
	a.state.Tail = hashHex(chainNext(tail, canonical))
	a.state.Events = append(append([]CreationAuditEvent{}, a.state.Events...), event)
	if len(a.state.Events) > CreationAuditLimit {
		// The dropped event leaves the file but not the chain: the new base is
		// its hash, so a verifier still proves every retained event from it.
		base, err := hashFromHex(a.state.Base)
		if err != nil {
			return err
		}
		dropped, err := canonicalJSON(a.state.Events[0])
		if err != nil {
			return err
		}
		a.state.Base = hashHex(chainNext(base, dropped))
		a.state.Events = a.state.Events[1:]
		a.state.Dropped++
	}
	if err := a.persist(); err != nil {
		a.state = previous
		return err
	}
	return nil
}

func (a *CreationAudit) attempt(req *http.Request) (CreationAuditEvent, error) {
	if !a.Armed() {
		return CreationAuditEvent{}, ErrAuditKeyMissing
	}
	id, err := a.auditUUID()
	if err != nil {
		return CreationAuditEvent{}, err
	}
	profile := strings.Trim(profileOf(req.URL.Path), "/")
	profile = strings.TrimPrefix(profile, "p/")
	if profile == "" {
		profile = "default"
	}
	hash := ""
	if key := req.Header.Get("Idempotency-Key"); key != "" {
		hash = fmt.Sprintf("%x", sha256.Sum256([]byte(key)))
	}
	event := CreationAuditEvent{EventID: id, AttemptID: id, Phase: "attempt", OccurredAt: a.now().UTC().Format(time.RFC3339Nano), RuntimeID: a.runtimeID,
		Profile: profile, CorrelationID: hash, IdempotencyKeyHash: hash, Method: "POST", Path: "/v1/runs"}
	return event, a.append(event)
}

func (a *CreationAudit) outcome(attempt CreationAuditEvent, resp *http.Response, dispatchErr error) error {
	id, err := a.auditUUID()
	if err != nil {
		return err
	}
	event := attempt
	event.EventID, event.Phase, event.OccurredAt = id, "outcome", a.now().UTC().Format(time.RFC3339Nano)
	event.Outcome = "ambiguous"
	if resp != nil {
		event.Status = resp.StatusCode
		// Read only a bounded prefix, restore it for the existing relay, and persist
		// evidence BEFORE any WebSocket send can fail. Never keep the prefix on disk.
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, creationAuditResponseLimit+1))
		resp.Body = &auditResponseBody{Reader: io.MultiReader(bytes.NewReader(body), resp.Body), Closer: resp.Body}
		if dispatchErr == nil && readErr == nil && len(body) <= creationAuditResponseLimit {
			if resp.StatusCode/100 != 2 {
				event.Outcome = "response"
			} else {
				var result struct {
					RunID string `json:"run_id"`
				}
				if json.Unmarshal(body, &result) == nil && runIDRe.MatchString(result.RunID) {
					event.RemoteID, event.Outcome = result.RunID, "response"
				}
			}
		}
	}
	return a.append(event)
}

type auditResponseBody struct {
	io.Reader
	io.Closer
}
