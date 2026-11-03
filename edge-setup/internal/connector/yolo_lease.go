package connector

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/yolohardline"
)

// The host side of a YOLO lease (docs/CONNECTOR.md, « Bail YOLO »): what was
// accepted, on which pinned keys, what was revoked, and the local kill of
// `edge-setup yolo off`. Every decision re-reads the wall clock and the kill
// file, so neither a stopped timer nor a dead link ever extends a lease.
//
// Files of the instance state directory, all 0600 and written atomically:
//
//	yolo-keys.json    the pinned public lease keys
//	yolo-leases.json  the accepted signed leases, the tombstones
//	yolo-kill.json    written by `edge-setup yolo off`, read here
const (
	yoloKeysFile   = "yolo-keys.json"
	yoloLeasesFile = "yolo-leases.json"
	// YoloKillFile is the local kill switch, shared with the CLI.
	YoloKillFile = "yolo-kill.json"
	// YoloMaxSeconds bounds expiresAt - issuedAt.
	YoloMaxSeconds = 86400
	// YoloClockSkewSeconds is the tolerated host clock lag on notBefore, never
	// on expiresAt.
	YoloClockSkewSeconds = 300
	// yoloRecentOutcomes bounds the refusals and endings yolo.state repeats.
	yoloRecentOutcomes = 32
)

// Reasons a lease is refused or ended, the codes of yolo.state and of
// openedbot's validateYoloLease.
const (
	YoloIssueShape             = "shape"
	YoloIssueKeyUnknown        = "key_unknown"
	YoloIssueSignatureInvalid  = "signature_invalid"
	YoloIssueScopeMismatch     = "scope_mismatch"
	YoloIssueWindowInvalid     = "window_invalid"
	YoloIssueDurationExceeded  = "duration_exceeded"
	YoloIssueProtectUnknown    = "protect_unknown"
	YoloIssueProtectIncomplete = "protect_incomplete"
	YoloIssueDenyInvalid       = "deny_invalid"
	YoloIssueRuntimeMismatch   = "runtime_mismatch"
	YoloIssueNotYetValid       = "not_yet_valid"
	YoloIssueExpired           = "expired"
	YoloIssueRevoked           = "revoked"
	YoloIssueKilled            = "killed"
)

// YoloLeaseIssue is a refusal with its code.
type YoloLeaseIssue struct{ Code string }

func (e *YoloLeaseIssue) Error() string { return "yolo lease refused: " + e.Code }

func issue(code string) error { return &YoloLeaseIssue{Code: code} }

// IssueCode is the code of a refusal, "" for any other error.
func IssueCode(err error) string {
	var refused *YoloLeaseIssue
	if errors.As(err, &refused) {
		return refused.Code
	}
	return ""
}

// YoloLeaseKeyID is the first 16 bytes, in hex, of sha256(raw public key).
func YoloLeaseKeyID(publicKey []byte) string {
	sum := sha256.Sum256(publicKey)
	return hex.EncodeToString(sum[:16])
}

// YoloLeaseMessage is what a lease signature covers.
func YoloLeaseMessage(lease YoloLease) ([]byte, error) {
	canonical, err := canonicalJSON(lease)
	if err != nil {
		return nil, err
	}
	return append([]byte(YoloLeaseSigningPrefix), canonical...), nil
}

func decodePublicKey(key YoloLeaseKey) (ed25519.PublicKey, bool) {
	raw, err := base64.StdEncoding.DecodeString(key.PublicKey)
	if err != nil || len(raw) != ed25519.PublicKeySize || YoloLeaseKeyID(raw) != key.KeyID {
		return nil, false
	}
	return ed25519.PublicKey(raw), true
}

// VerifyYoloLeaseSignature checks the signature on a pinned key only. A
// pinned entry whose id does not derive from its key pins nothing.
func VerifyYoloLeaseSignature(lease YoloLease, keyID, signature string, pinned []YoloLeaseKey) error {
	i := slices.IndexFunc(pinned, func(k YoloLeaseKey) bool { return k.KeyID == keyID })
	if i < 0 {
		return issue(YoloIssueKeyUnknown)
	}
	public, ok := decodePublicKey(pinned[i])
	if !ok {
		return issue(YoloIssueKeyUnknown)
	}
	sig, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return issue(YoloIssueSignatureInvalid)
	}
	message, err := YoloLeaseMessage(lease)
	if err != nil || !ed25519.Verify(public, message, sig) {
		return issue(YoloIssueSignatureInvalid)
	}
	return nil
}

// The command blocklist grammar of openedbot (normalizeCommandBlocklist).
var (
	blocklistFirstWord = regexp.MustCompile(`^[A-Za-z0-9._+-]+$`)
	blocklistOtherWord = regexp.MustCompile(`^[A-Za-z0-9._/:=,+@%~-]+$`)
)

const (
	blocklistMaxEntries = 50
	blocklistMaxLength  = 120
)

func validCommandBlocklist(entries []string) bool {
	seen := map[string]bool{}
	for _, raw := range entries {
		entry := strings.Join(strings.Fields(raw), " ")
		if entry == "" || len(utf16Units(entry)) > blocklistMaxLength {
			return false
		}
		words := strings.Split(entry, " ")
		for _, word := range words {
			if !blocklistOtherWord.MatchString(word) {
				return false
			}
		}
		if !blocklistFirstWord.MatchString(words[0]) || words[0] == "sudo" || words[0] == "command" {
			return false
		}
		seen[entry] = true
	}
	return len(seen) <= blocklistMaxEntries
}

// ValidateYoloLeaseShape is what a lease says of itself, without a clock or
// a host: scope consistent with profile and sessionKey, an ordered window of
// at most 24 hours, known and complete protections, a well-formed deny-list.
func ValidateYoloLeaseShape(lease YoloLease) error {
	scoped := false
	switch lease.Scope {
	case "thread":
		scoped = lease.Profile != nil && lease.SessionKey != nil
	case "bot":
		scoped = lease.Profile != nil && lease.SessionKey == nil
	case "runtime":
		scoped = lease.Profile == nil && lease.SessionKey == nil
	}
	if !scoped {
		return issue(YoloIssueScopeMismatch)
	}
	if lease.NotBefore < lease.IssuedAt || lease.ExpiresAt <= lease.NotBefore {
		return issue(YoloIssueWindowInvalid)
	}
	if lease.ExpiresAt-lease.IssuedAt > YoloMaxSeconds {
		return issue(YoloIssueDurationExceeded)
	}
	for _, id := range lease.Protect {
		if !yolohardline.IsProtectionID(id) {
			return issue(YoloIssueProtectUnknown)
		}
	}
	for _, id := range yolohardline.DefaultProtect() {
		if !slices.Contains(lease.Protect, id) {
			return issue(YoloIssueProtectIncomplete)
		}
	}
	if !validCommandBlocklist(lease.Deny.Commands) {
		return issue(YoloIssueDenyInvalid)
	}
	return nil
}

// YoloLeaseContext is the host and the instant a lease is judged against.
type YoloLeaseContext struct {
	Now       int64
	RuntimeID string
	// Revoked reports a local tombstone.
	Revoked func(lease YoloLease) bool
	// KilledAt is `edge-setup yolo off`: a lease issued at or before it is dead.
	KilledAt int64
}

// ValidateYoloLease is what the lease is worth here and now.
func ValidateYoloLease(lease YoloLease, ctx YoloLeaseContext) error {
	if err := ValidateYoloLeaseShape(lease); err != nil {
		return err
	}
	if lease.RuntimeID != ctx.RuntimeID {
		return issue(YoloIssueRuntimeMismatch)
	}
	if ctx.Revoked != nil && ctx.Revoked(lease) {
		return issue(YoloIssueRevoked)
	}
	if ctx.KilledAt > 0 && lease.IssuedAt <= ctx.KilledAt {
		return issue(YoloIssueKilled)
	}
	if ctx.Now < lease.NotBefore-YoloClockSkewSeconds {
		return issue(YoloIssueNotYetValid)
	}
	if ctx.Now >= lease.ExpiresAt {
		return issue(YoloIssueExpired)
	}
	return nil
}

// YoloKill is yolo-kill.json. Off while LiftedAt is zero: every lease is
// refused. `yolo on` sets LiftedAt; KilledAt stays, so a lease issued before
// the kill never comes back.
type YoloKill struct {
	Schema   int   `json:"schema"`
	KilledAt int64 `json:"killedAt"`
	LiftedAt int64 `json:"liftedAt,omitempty"`
}

// Active reports whether the kill still refuses every lease.
func (k YoloKill) Active() bool { return k.KilledAt > 0 && k.LiftedAt == 0 }

// ReadYoloKill reads the kill file of a state directory; absent is zero. A
// file that cannot be read or parsed counts as a kill at the epoch of its
// failure: refusing is the safe reading.
func ReadYoloKill(stateDir string, now time.Time) (YoloKill, error) {
	data, err := os.ReadFile(filepath.Join(stateDir, YoloKillFile))
	if errors.Is(err, os.ErrNotExist) {
		return YoloKill{}, nil
	}
	var kill YoloKill
	if err == nil {
		err = json.Unmarshal(data, &kill)
	}
	if err != nil || kill.Schema != 1 || kill.KilledAt <= 0 {
		return YoloKill{Schema: 1, KilledAt: now.Unix()}, fmt.Errorf("%s is unreadable or invalid: every lease is refused", YoloKillFile)
	}
	return kill, nil
}

// WriteYoloKill writes the kill file atomically, 0600.
func WriteYoloKill(stateDir string, kill YoloKill, owner fsx.Owner) error {
	kill.Schema = 1
	data, err := json.MarshalIndent(kill, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(filepath.Join(stateDir, YoloKillFile), append(data, '\n'), 0o600, owner)
}

// StoredYoloLease is one signed lease as received, re-verified at every load.
type StoredYoloLease struct {
	Lease      YoloLease `json:"lease"`
	KeyID      string    `json:"keyId"`
	Signature  string    `json:"signature"`
	ReceivedAt int64     `json:"receivedAt"`
}

type yoloOutcome struct {
	LeaseID string `json:"leaseId"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	At      int64  `json:"at"`
}

type yoloLeasesDoc struct {
	Schema    int               `json:"schema"`
	RuntimeID string            `json:"runtimeId"`
	Leases    []StoredYoloLease `json:"leases"`
	// Tombstones maps a revoked lease id to the instant it may be forgotten:
	// past it, the lease would have expired anyway.
	Tombstones map[string]int64 `json:"tombstones"`
	// RevokedAllAt kills every lease issued at or before it (yolo.revoke all).
	RevokedAllAt int64         `json:"revokedAllAt,omitempty"`
	Recent       []yoloOutcome `json:"recent,omitempty"`
}

type yoloKeysDoc struct {
	Schema    int            `json:"schema"`
	RuntimeID string         `json:"runtimeId"`
	Keys      []YoloLeaseKey `json:"keys"`
}

// YoloStore holds the leases of one runtime. It never creates a lease: only
// a frame signed on a pinned key adds one.
type YoloStore struct {
	dir       string
	runtimeID string
	owner     fsx.Owner
	now       func() time.Time
	logf      func(string, ...any)

	mu   sync.Mutex
	keys []YoloLeaseKey
	// tofuSpent: a pin file exists (or existed unreadable); a new key then
	// needs an endorsement.
	tofuSpent bool
	doc       yoloLeasesDoc
	// onChange runs, outside the lock, after every change of what is active.
	onChange func()
	timer    *time.Timer
}

// OpenYoloStore loads the store of a state directory. Every stored lease is
// verified again on the pinned keys; one that no longer verifies is dropped.
// trusted are keys pinned unconditionally (link.json, written by root at
// enrollment).
func OpenYoloStore(dir, runtimeID string, trusted []YoloLeaseKey, now func() time.Time, logf func(string, ...any)) (*YoloStore, error) {
	if runtimeID == "" {
		return nil, errors.New("yolo store requires a runtime id")
	}
	if now == nil {
		now = time.Now
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	s := &YoloStore{dir: dir, runtimeID: runtimeID, owner: fsx.Current(), now: now, logf: logf}
	var keys yoloKeysDoc
	present, err := readYoloJSON(filepath.Join(dir, yoloKeysFile), &keys)
	if err != nil {
		// Fail closed: a pin file that exists but cannot be read is never
		// replaced by a fresh first use, so no key can be pinned without an
		// endorsement until the host is enrolled again.
		logf("yolo: %v; no lease key is pinned and none will be until re-enrollment", err)
		s.tofuSpent = true
	}
	if present && keys.Schema == 1 && keys.RuntimeID == runtimeID {
		s.tofuSpent = true
		for _, key := range keys.Keys {
			if _, ok := decodePublicKey(key); ok {
				s.keys = append(s.keys, YoloLeaseKey{KeyID: key.KeyID, PublicKey: key.PublicKey})
			}
		}
	}
	changed := false
	for _, key := range trusted {
		if _, ok := decodePublicKey(key); ok && !slices.ContainsFunc(s.keys, func(k YoloLeaseKey) bool { return k.KeyID == key.KeyID }) {
			s.keys = append(s.keys, YoloLeaseKey{KeyID: key.KeyID, PublicKey: key.PublicKey})
			changed = true
		}
	}
	if changed {
		if err := s.persistKeys(); err != nil {
			return nil, err
		}
	}
	var doc yoloLeasesDoc
	if _, err := readYoloJSON(filepath.Join(dir, yoloLeasesFile), &doc); err != nil {
		// A file this host cannot read holds no lease: start empty, loudly.
		logf("yolo: %v; no lease is held", err)
		doc = yoloLeasesDoc{}
	}
	s.doc = yoloLeasesDoc{Schema: 1, RuntimeID: runtimeID, Tombstones: map[string]int64{}}
	if doc.Schema == 1 && doc.RuntimeID == runtimeID {
		s.doc.RevokedAllAt, s.doc.Recent = doc.RevokedAllAt, doc.Recent
		for id, until := range doc.Tombstones {
			s.doc.Tombstones[id] = until
		}
		for _, stored := range doc.Leases {
			if err := VerifyYoloLeaseSignature(stored.Lease, stored.KeyID, stored.Signature, s.keys); err != nil {
				logf("yolo lease %s dropped at load: %v", stored.Lease.LeaseID, err)
				continue
			}
			s.doc.Leases = append(s.doc.Leases, stored)
		}
	}
	return s, nil
}

// readYoloJSON reports whether the file exists, and an error when it exists
// but cannot be read or parsed.
func readYoloJSON(path string, into any) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	if err := json.Unmarshal(data, into); err != nil {
		return true, fmt.Errorf("%s is invalid: %w", filepath.Base(path), err)
	}
	return true, nil
}

// SetOnChange registers the callback run after a change of the active set.
func (s *YoloStore) SetOnChange(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onChange = fn
}

func (s *YoloStore) changed() {
	s.mu.Lock()
	fn := s.onChange
	s.armTimerLocked()
	s.mu.Unlock()
	if fn != nil {
		fn()
	}
}

// armTimerLocked schedules onChange at the next expiry; each decision
// re-reads the clock anyway.
func (s *YoloStore) armTimerLocked() {
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	now := s.now().Unix()
	next := int64(0)
	for _, stored := range s.doc.Leases {
		if at := stored.Lease.ExpiresAt; at > now && (next == 0 || at < next) {
			next = at
		}
	}
	if next == 0 {
		return
	}
	s.timer = time.AfterFunc(time.Duration(next-now)*time.Second, s.changed)
}

// Stop releases the expiry timer.
func (s *YoloStore) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

func (s *YoloStore) persistKeys() error {
	data, err := json.MarshalIndent(yoloKeysDoc{Schema: 1, RuntimeID: s.runtimeID, Keys: s.keys}, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(filepath.Join(s.dir, yoloKeysFile), append(data, '\n'), 0o600, s.owner)
}

func (s *YoloStore) persistLocked() error {
	now := s.now().Unix()
	for id, until := range s.doc.Tombstones {
		if until < now {
			delete(s.doc.Tombstones, id)
		}
	}
	data, err := json.MarshalIndent(s.doc, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(filepath.Join(s.dir, yoloLeasesFile), append(data, '\n'), 0o600, s.owner)
}

// PinnedKeys is a copy of the pinned keys.
func (s *YoloStore) PinnedKeys() []YoloLeaseKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.keys)
}

// PinKeys applies a leaseKeys announcement. The first announcement pins
// (trust on first use); afterwards a new key is pinned only when a key
// already pinned endorses it, and a pinned id never changes its key. Keys are
// never unpinned by the link: a refusal keeps every pin as it was.
func (s *YoloStore) PinKeys(announced []YoloLeaseKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	first := len(s.keys) == 0 && !s.tofuSpent
	next := slices.Clone(s.keys)
	var refused []string
	for _, key := range announced {
		if _, ok := decodePublicKey(key); !ok {
			refused = append(refused, key.KeyID+" (id does not derive from its key)")
			continue
		}
		if i := slices.IndexFunc(next, func(k YoloLeaseKey) bool { return k.KeyID == key.KeyID }); i >= 0 {
			if next[i].PublicKey != key.PublicKey {
				refused = append(refused, key.KeyID+" (a pinned id with another key)")
			}
			continue
		}
		if !first && !s.endorsedLocked(key) {
			refused = append(refused, key.KeyID+" (not endorsed by a pinned key)")
			continue
		}
		if len(next) >= YoloMaxLeaseKeys {
			refused = append(refused, key.KeyID+" (too many pinned keys)")
			continue
		}
		next = append(next, YoloLeaseKey{KeyID: key.KeyID, PublicKey: key.PublicKey})
	}
	if len(next) != len(s.keys) {
		previous := s.keys
		s.keys = next
		if err := s.persistKeys(); err != nil {
			s.keys = previous
			return err
		}
		s.tofuSpent = true
	}
	if len(refused) > 0 {
		return fmt.Errorf("lease keys refused: %s", strings.Join(refused, ", "))
	}
	return nil
}

func (s *YoloStore) endorsedLocked(key YoloLeaseKey) bool {
	if key.EndorsedBy == "" {
		return false
	}
	i := slices.IndexFunc(s.keys, func(k YoloLeaseKey) bool { return k.KeyID == key.EndorsedBy })
	if i < 0 {
		return false
	}
	endorser, ok := decodePublicKey(s.keys[i])
	sig, err := base64.StdEncoding.DecodeString(key.Endorsement)
	if !ok || err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(endorser, []byte(YoloKeyEndorsementPrefix+key.KeyID+"\n"+key.PublicKey), sig)
}

func (s *YoloStore) kill() YoloKill {
	kill, err := ReadYoloKill(s.dir, s.now())
	if err != nil {
		s.logf("%v", err)
	}
	return kill
}

func (s *YoloStore) revokedLocked(lease YoloLease) bool {
	if _, ok := s.doc.Tombstones[lease.LeaseID]; ok {
		return true
	}
	return s.doc.RevokedAllAt > 0 && lease.IssuedAt <= s.doc.RevokedAllAt
}

func (s *YoloStore) contextLocked(kill YoloKill) YoloLeaseContext {
	return YoloLeaseContext{Now: s.now().Unix(), RuntimeID: s.runtimeID, Revoked: s.revokedLocked, KilledAt: kill.KilledAt}
}

func (s *YoloStore) noteLocked(leaseID, status, reason string) {
	s.doc.Recent = slices.DeleteFunc(s.doc.Recent, func(o yoloOutcome) bool { return o.LeaseID == leaseID })
	s.doc.Recent = append(s.doc.Recent, yoloOutcome{LeaseID: leaseID, Status: status, Reason: reason, At: s.now().Unix()})
	if len(s.doc.Recent) > yoloRecentOutcomes {
		s.doc.Recent = s.doc.Recent[len(s.doc.Recent)-yoloRecentOutcomes:]
	}
}

// Accept verifies a yolo.lease frame and keeps the lease: signature on a
// pinned key, shape, runtime, tombstones, the local kill, the time window.
// A refusal is remembered for yolo.state and returned as a YoloLeaseIssue.
func (s *YoloStore) Accept(frame *YoloFrame) error {
	if frame == nil || frame.Lease == nil {
		return issue(YoloIssueShape)
	}
	lease := *frame.Lease
	kill := s.kill()
	s.mu.Lock()
	err := VerifyYoloLeaseSignature(lease, frame.KeyID, frame.Signature, s.keys)
	if err == nil {
		err = ValidateYoloLease(lease, s.contextLocked(kill))
	}
	if err == nil && kill.Active() {
		err = issue(YoloIssueKilled)
	}
	if err != nil {
		s.noteLocked(lease.LeaseID, YoloRejected, IssueCode(err))
		_ = s.persistLocked()
		s.mu.Unlock()
		s.changed()
		return err
	}
	s.doc.Leases = slices.DeleteFunc(s.doc.Leases, func(l StoredYoloLease) bool { return l.Lease.LeaseID == lease.LeaseID })
	s.doc.Leases = append(s.doc.Leases, StoredYoloLease{Lease: lease, KeyID: frame.KeyID, Signature: frame.Signature, ReceivedAt: s.now().Unix()})
	s.noteLocked(lease.LeaseID, YoloActive, "")
	if err := s.persistLocked(); err != nil {
		// Not durable, not held: a lease this host could not write would not
		// survive a restart and must not be applied either.
		s.doc.Leases = s.doc.Leases[:len(s.doc.Leases)-1]
		s.mu.Unlock()
		return err
	}
	s.mu.Unlock()
	s.changed()
	return nil
}

// Revoke applies yolo.revoke: one lease, or every lease issued at or before
// revokedAt. A revocation only restricts, so it needs no signature.
func (s *YoloStore) Revoke(frame *YoloFrame) error {
	if frame == nil {
		return errors.New("yolo.revoke without body")
	}
	s.mu.Lock()
	until := s.now().Unix() + YoloMaxSeconds + YoloClockSkewSeconds
	if frame.All {
		s.doc.RevokedAllAt = max(s.doc.RevokedAllAt, frame.RevokedAt)
	}
	for _, stored := range s.doc.Leases {
		if frame.All || stored.Lease.LeaseID == frame.LeaseID {
			s.doc.Tombstones[stored.Lease.LeaseID] = until
			s.noteLocked(stored.Lease.LeaseID, YoloRevoked, "")
		}
	}
	if !frame.All {
		s.doc.Tombstones[frame.LeaseID] = until
	}
	s.doc.Leases = slices.DeleteFunc(s.doc.Leases, func(l StoredYoloLease) bool { return s.revokedLocked(l.Lease) })
	err := s.persistLocked()
	s.mu.Unlock()
	s.changed()
	return err
}

// Active is every lease valid now, re-checked against the clock, the
// tombstones and the kill file. Leases that ended are dropped and recorded.
func (s *YoloStore) Active() []YoloLease {
	kill := s.kill()
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx := s.contextLocked(kill)
	var active []YoloLease
	kept := s.doc.Leases[:0]
	dropped := false
	for _, stored := range s.doc.Leases {
		err := ValidateYoloLease(stored.Lease, ctx)
		if err == nil && kill.Active() {
			err = issue(YoloIssueKilled)
		}
		switch code := IssueCode(err); {
		case err == nil:
			active = append(active, stored.Lease)
			kept = append(kept, stored)
		case code == YoloIssueNotYetValid:
			kept = append(kept, stored)
		default:
			status := YoloExpired
			if code != YoloIssueExpired {
				status = YoloRevoked
			}
			s.noteLocked(stored.Lease.LeaseID, status, code)
			dropped = true
		}
	}
	s.doc.Leases = kept
	if dropped {
		if err := s.persistLocked(); err != nil {
			s.logf("yolo leases could not be persisted: %v", err)
		}
	}
	return active
}

// Lookup is the lease that covers a gate of profile in the session whose key
// is sessionKey ("" when unknown), or nil. The narrowest scope wins: a thread
// lease, then a bot lease, then a runtime lease; within one, the latest expiry.
func (s *YoloStore) Lookup(profile, sessionKey string) *YoloLease {
	return CoveringLease(s.Active(), profile, sessionKey)
}

// CoveringLease picks, among active leases, the one that covers a gate.
func CoveringLease(active []YoloLease, profile, sessionKey string) *YoloLease {
	rank := func(l YoloLease) int {
		switch {
		case l.Scope == "thread" && l.Profile != nil && *l.Profile == profile && sessionKey != "" && l.SessionKey != nil && *l.SessionKey == sessionKey:
			return 3
		case l.Scope == "bot" && l.Profile != nil && *l.Profile == profile:
			return 2
		case l.Scope == "runtime":
			return 1
		}
		return 0
	}
	var best *YoloLease
	for i := range active {
		l := active[i]
		r := rank(l)
		if r == 0 {
			continue
		}
		if best == nil || r > rank(*best) || (r == rank(*best) && l.ExpiresAt > best.ExpiresAt) {
			best = &active[i]
		}
	}
	return best
}

// State is what yolo.state reports: the active leases, the recent endings
// and refusals, and the kill while it holds.
func (s *YoloStore) State() ([]YoloLeaseState, *int64) {
	active := s.Active()
	kill := s.kill()
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []YoloLeaseState
	seen := map[string]bool{}
	for _, lease := range active {
		out = append(out, YoloLeaseState{LeaseID: lease.LeaseID, Status: YoloActive})
		seen[lease.LeaseID] = true
	}
	recent := slices.Clone(s.doc.Recent)
	sort.SliceStable(recent, func(i, j int) bool { return recent[i].At > recent[j].At })
	for _, o := range recent {
		if seen[o.LeaseID] || o.Status == YoloActive || len(out) >= YoloStateMaxLeases {
			continue
		}
		seen[o.LeaseID] = true
		out = append(out, YoloLeaseState{LeaseID: o.LeaseID, Status: o.Status, Reason: o.Reason})
	}
	if kill.Active() {
		at := kill.KilledAt
		return out, &at
	}
	return out, nil
}

// Held is every stored lease, active or not yet valid, for `yolo status`.
func (s *YoloStore) Held() []StoredYoloLease {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.doc.Leases)
}

// YoloLeaseStatus is one held lease as `edge-setup yolo status` shows it.
type YoloLeaseStatus struct {
	LeaseID   string  `json:"leaseId"`
	Scope     string  `json:"scope"`
	Profile   *string `json:"profile"`
	Thread    bool    `json:"thread"`
	ExpiresAt int64   `json:"expiresAt"`
	Status    string  `json:"status"`
	Reason    string  `json:"reason,omitempty"`
}

// YoloHostStatus is what a state directory says, read without writing.
type YoloHostStatus struct {
	Kill         YoloKill          `json:"kill"`
	KillProblem  string            `json:"killProblem,omitempty"`
	PinnedKeys   int               `json:"pinnedKeys"`
	Leases       []YoloLeaseStatus `json:"leases"`
	PendingAudit int               `json:"pendingAudit"`
	Problems     []string          `json:"problems,omitempty"`
}

// ReadYoloStatus reads a state directory offline and changes nothing: every
// held lease is verified on the pinned keys and judged at now.
func ReadYoloStatus(dir, runtimeID string, trusted []YoloLeaseKey, now time.Time) YoloHostStatus {
	status := YoloHostStatus{Leases: []YoloLeaseStatus{}}
	kill, err := ReadYoloKill(dir, now)
	status.Kill = kill
	if err != nil {
		status.KillProblem = err.Error()
	}
	var keysDoc yoloKeysDoc
	if _, err := readYoloJSON(filepath.Join(dir, yoloKeysFile), &keysDoc); err != nil {
		status.Problems = append(status.Problems, err.Error())
	}
	keys := slices.Clone(trusted)
	if keysDoc.RuntimeID == runtimeID {
		keys = append(keys, keysDoc.Keys...)
	}
	status.PinnedKeys = len(keys)
	var doc yoloLeasesDoc
	if _, err := readYoloJSON(filepath.Join(dir, yoloLeasesFile), &doc); err != nil {
		status.Problems = append(status.Problems, err.Error())
	}
	if doc.RuntimeID == runtimeID {
		revoked := func(l YoloLease) bool {
			_, tomb := doc.Tombstones[l.LeaseID]
			return tomb || (doc.RevokedAllAt > 0 && l.IssuedAt <= doc.RevokedAllAt)
		}
		ctx := YoloLeaseContext{Now: now.Unix(), RuntimeID: runtimeID, Revoked: revoked, KilledAt: kill.KilledAt}
		for _, stored := range doc.Leases {
			l := stored.Lease
			entry := YoloLeaseStatus{LeaseID: l.LeaseID, Scope: l.Scope, Profile: l.Profile, Thread: l.SessionKey != nil, ExpiresAt: l.ExpiresAt, Status: YoloActive}
			err := VerifyYoloLeaseSignature(l, stored.KeyID, stored.Signature, keys)
			if err == nil {
				err = ValidateYoloLease(l, ctx)
			}
			if err == nil && kill.Active() {
				err = issue(YoloIssueKilled)
			}
			if err != nil {
				entry.Status, entry.Reason = YoloRevoked, IssueCode(err)
				if entry.Reason == YoloIssueExpired {
					entry.Status = YoloExpired
				}
			}
			status.Leases = append(status.Leases, entry)
		}
	}
	if data, err := os.ReadFile(filepath.Join(dir, yoloPendingFile)); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) != "" {
				status.PendingAudit++
			}
		}
	}
	return status
}
