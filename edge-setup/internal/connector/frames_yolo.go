package connector

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"

	"github.com/OpenedBot/openedbot/edge-setup/internal/yolohardline"
)

// The YOLO frames (docs/CONNECTOR.md, « Bail YOLO »): the signed lease
// openedbot pushes once, its revocation, the state the host holds of them and
// the local audit of its auto-approvals. Decoded as strictly as openedbot's
// contracts/connector/src/relay-frames-yolo.ts: the shared vectors
// (test/golden/relay-frames/vectors.json) hold both sides to it.
const (
	TYoloLease    = "yolo.lease"
	TYoloRevoke   = "yolo.revoke"
	TYoloState    = "yolo.state"
	TYoloAudit    = "yolo.audit"
	TYoloAuditAck = "yolo.audit.ack"
)

// FeatureYoloLease: the host verifies and enforces YOLO leases offline.
// FeatureYoloThreadScope: it can hold a lease to one Hermes session (the
// approval plugin's pre_tool_call hook receives session_id, and the connector
// knows the session of every run it dispatched). Without the second one a
// thread lease is refused, never widened.
const (
	FeatureYoloLease       = "yolo_lease"
	FeatureYoloThreadScope = "yolo_thread_scope"
)

// YoloLeaseSigningPrefix is the domain prefix of the signed message:
// prefix || canonical(lease). A technical identifier, frozen.
const YoloLeaseSigningPrefix = "ohb-yolo-lease/v1\n"

// YoloKeyEndorsementPrefix is the domain prefix of a lease key endorsement:
// prefix || keyId || "\n" || publicKey, signed by an already pinned key.
const YoloKeyEndorsementPrefix = "ohb-yolo-key/v1\n"

// Bounds, identical to relay-frames-yolo.ts.
const (
	YoloDenyMaxEntries    = 50
	YoloDenyMaxLength     = 256
	YoloProtectMaxEntries = 32
	YoloStateMaxLeases    = 64
	YoloAuditMaxEntries   = 128
	YoloMaxLeaseKeys      = 8
	yoloMaxRuntimeID      = 128
	yoloMaxToolKey        = 256
	maxSafeInteger        = 1<<53 - 1
)

// Statuses of a lease in yolo.state.
const (
	YoloActive   = "active"
	YoloExpired  = "expired"
	YoloRevoked  = "revoked"
	YoloRejected = "rejected"
)

var (
	yoloKeyIDRe     = regexp.MustCompile(`^[0-9a-f]{32}$`)
	yoloHex64Re     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	yoloSig64Re     = regexp.MustCompile(`^[A-Za-z0-9+/]{86}==$`)
	yoloPub32Re     = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)
	yoloProfileRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	yoloProtectIDRe = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
	yoloCodeRe      = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
	yoloGateKindRe  = regexp.MustCompile(`^[a-z_]{1,32}$`)
)

// YoloLease is the canonical lease payload, v1. Integers only; instants are
// epoch seconds. Profile and SessionKey are always present on the wire, null
// when unset: the canonical form depends on it.
type YoloLease struct {
	V              int               `json:"v"`
	LeaseID        string            `json:"leaseId"`
	OrganizationID string            `json:"organizationId"`
	RuntimeID      string            `json:"runtimeId"`
	Scope          string            `json:"scope"`
	Profile        *string           `json:"profile"`
	SessionKey     *string           `json:"sessionKey"`
	IssuedAt       int64             `json:"issuedAt"`
	NotBefore      int64             `json:"notBefore"`
	ExpiresAt      int64             `json:"expiresAt"`
	GrantedBy      string            `json:"grantedBy"`
	Deny           yolohardline.Deny `json:"deny"`
	Protect        []string          `json:"protect"`
}

// YoloLeaseKey is one public lease key openedbot announces in link.context
// (leaseKeys). A key that is not pinned yet is accepted only endorsed by one
// that is (EndorsedBy, Endorsement), except on the very first pin.
type YoloLeaseKey struct {
	KeyID       string `json:"keyId"`
	PublicKey   string `json:"publicKey"`
	EndorsedBy  string `json:"endorsedBy,omitempty"`
	Endorsement string `json:"endorsement,omitempty"`
}

// YoloLeaseState is one entry of yolo.state.
type YoloLeaseState struct {
	LeaseID string `json:"leaseId"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
}

// YoloAuditEntry is one auto-approval of the local audit: the hash of the
// arguments only, never the arguments. PrevHash and EntryHash chain them.
type YoloAuditEntry struct {
	Seq        uint64  `json:"seq"`
	EventID    string  `json:"eventId"`
	OccurredAt int64   `json:"occurredAt"`
	LeaseID    string  `json:"leaseId"`
	Profile    string  `json:"profile"`
	GateKind   string  `json:"gateKind"`
	ToolKey    *string `json:"toolKey"`
	ArgsHash   string  `json:"argsHash"`
	PrevHash   string  `json:"prevHash"`
	EntryHash  string  `json:"entryHash"`
}

// YoloFrame is the decoded body of a yolo.* frame; which fields are set
// depends on the type.
type YoloFrame struct {
	// yolo.lease
	Lease     *YoloLease
	KeyID     string
	Signature string
	// yolo.revoke: exactly one of LeaseID or All.
	LeaseID   string
	All       bool
	RevokedAt int64
	// yolo.state
	Leases   []YoloLeaseState
	KilledAt *int64
	// yolo.audit; ToSeq is also yolo.audit.ack's.
	RuntimeID string
	Entries   []YoloAuditEntry
	FromSeq   uint64
	ToSeq     uint64
	Tail      string
}

type yoloObject map[string]json.RawMessage

func yoloObjectOf(raw json.RawMessage, name string) (yoloObject, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, fmt.Errorf("%s must be an object", name)
	}
	var out yoloObject
	if err := json.Unmarshal(trimmed, &out); err != nil {
		return nil, fmt.Errorf("%s must be an object", name)
	}
	return out, nil
}

func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// text: absent or null is unset; anything but a string is a refusal.
func (o yoloObject) text(key string) (string, bool, error) {
	raw, ok := o[key]
	if !ok || isNull(raw) {
		return "", false, nil
	}
	var s string
	if bytes.TrimSpace(raw)[0] != '"' || json.Unmarshal(raw, &s) != nil {
		return "", false, fmt.Errorf("field %s must be a string", key)
	}
	return s, true, nil
}

// nullableText is a signed nullable field: present, a non-empty string or null.
func (o yoloObject) nullableText(key string) (*string, error) {
	raw, ok := o[key]
	if !ok {
		return nil, fmt.Errorf("field %s is required (null when unset)", key)
	}
	if isNull(raw) {
		return nil, nil
	}
	s, _, err := o.text(key)
	if err != nil || s == "" {
		return nil, fmt.Errorf("field %s must be a non-empty string or null", key)
	}
	return &s, nil
}

func (o yoloObject) uuid(key string) (string, error) {
	s, _, err := o.text(key)
	if err != nil || !eventIDRe.MatchString(s) {
		return "", fmt.Errorf("field %s must be a UUID", key)
	}
	return s, nil
}

// epoch is a non-negative safe integer, read the way JavaScript reads a JSON
// number (1e3 and 1.0 are integers, 1.5 is not).
func (o yoloObject) epoch(key string) (int64, error) {
	raw, ok := o[key]
	bad := fmt.Errorf("field %s must be a non-negative integer", key)
	if !ok {
		return 0, bad
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || (trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9')) {
		return 0, bad
	}
	var f float64
	if json.Unmarshal(trimmed, &f) != nil || f != math.Trunc(f) || f < 0 || f > maxSafeInteger {
		return 0, bad
	}
	return int64(f), nil
}

func (o yoloObject) list(key string, max int) ([]json.RawMessage, error) {
	raw, ok := o[key]
	trimmed := bytes.TrimSpace(raw)
	var out []json.RawMessage
	if !ok || len(trimmed) == 0 || trimmed[0] != '[' || json.Unmarshal(trimmed, &out) != nil {
		return nil, fmt.Errorf("field %s must be an array", key)
	}
	if len(out) > max {
		return nil, fmt.Errorf("field %s lists %d entries, more than %d", key, len(out), max)
	}
	return out, nil
}

func (o yoloObject) textList(key string, max, maxLength int) ([]string, error) {
	items, err := o.list(key, max)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		var s string
		trimmed := bytes.TrimSpace(item)
		if len(trimmed) == 0 || trimmed[0] != '"' || json.Unmarshal(trimmed, &s) != nil || s == "" || len(utf16Units(s)) > maxLength {
			return nil, fmt.Errorf("field %s must hold non-empty strings of at most %d characters", key, maxLength)
		}
		out = append(out, s)
	}
	return out, nil
}

var yoloLeaseKeys = []string{"v", "leaseId", "organizationId", "runtimeId", "scope", "profile", "sessionKey", "issuedAt", "notBefore", "expiresAt", "grantedBy", "deny", "protect"}

// ParseYoloLease reads a lease payload, strictly: an unknown field is a
// refusal, since what is signed is exactly the v1 content.
func ParseYoloLease(raw json.RawMessage) (YoloLease, error) {
	o, err := yoloObjectOf(raw, "lease")
	if err != nil {
		return YoloLease{}, err
	}
	for key := range o {
		if !slices.Contains(yoloLeaseKeys, key) {
			return YoloLease{}, fmt.Errorf("lease has an unknown field %s", key)
		}
	}
	var lease YoloLease
	if v, err := o.epoch("v"); err != nil || v != 1 {
		return YoloLease{}, errors.New("lease v must be 1")
	}
	lease.V = 1
	runtimeID, _, err := o.text("runtimeId")
	if err != nil || runtimeID == "" || len(utf16Units(runtimeID)) > yoloMaxRuntimeID {
		return YoloLease{}, errors.New("lease runtimeId is required")
	}
	lease.RuntimeID = runtimeID
	scope, _, err := o.text("scope")
	if err != nil || (scope != "thread" && scope != "bot" && scope != "runtime") {
		return YoloLease{}, errors.New("lease scope must be thread|bot|runtime")
	}
	lease.Scope = scope
	if lease.Profile, err = o.nullableText("profile"); err != nil {
		return YoloLease{}, err
	}
	if lease.Profile != nil && !yoloProfileRe.MatchString(*lease.Profile) {
		return YoloLease{}, errors.New("lease profile must be a profile slug or null")
	}
	if lease.SessionKey, err = o.nullableText("sessionKey"); err != nil {
		return YoloLease{}, err
	}
	if lease.SessionKey != nil && !yoloHex64Re.MatchString(*lease.SessionKey) {
		return YoloLease{}, errors.New("lease sessionKey must be 64 hex or null")
	}
	deny, err := yoloObjectOf(o["deny"], "lease.deny")
	if err != nil {
		return YoloLease{}, err
	}
	for key := range deny {
		if key != "commands" && key != "tools" && key != "paths" {
			return YoloLease{}, fmt.Errorf("lease.deny has an unknown field %s", key)
		}
	}
	protect, err := o.textList("protect", YoloProtectMaxEntries, 32)
	if err != nil {
		return YoloLease{}, err
	}
	seen := map[string]bool{}
	for _, id := range protect {
		if !yoloProtectIDRe.MatchString(id) || seen[id] {
			return YoloLease{}, errors.New("lease protect must list distinct protection ids, at least one")
		}
		seen[id] = true
	}
	if len(protect) == 0 {
		return YoloLease{}, errors.New("lease protect must list distinct protection ids, at least one")
	}
	lease.Protect = protect
	for _, field := range []struct {
		key string
		to  *string
	}{{"leaseId", &lease.LeaseID}, {"organizationId", &lease.OrganizationID}, {"grantedBy", &lease.GrantedBy}} {
		if *field.to, err = o.uuid(field.key); err != nil {
			return YoloLease{}, err
		}
	}
	for _, field := range []struct {
		key string
		to  *int64
	}{{"issuedAt", &lease.IssuedAt}, {"notBefore", &lease.NotBefore}, {"expiresAt", &lease.ExpiresAt}} {
		if *field.to, err = o.epoch(field.key); err != nil {
			return YoloLease{}, err
		}
	}
	for _, field := range []struct {
		key string
		to  *[]string
	}{{"commands", &lease.Deny.Commands}, {"tools", &lease.Deny.Tools}, {"paths", &lease.Deny.Paths}} {
		if *field.to, err = deny.textList(field.key, YoloDenyMaxEntries, YoloDenyMaxLength); err != nil {
			return YoloLease{}, err
		}
	}
	return lease, nil
}

// decodeYoloFrame validates a yolo.* frame with the rules of
// relay-frames-yolo.ts; DecodeText has already parsed the envelope.
func decodeYoloFrame(t string, b []byte) (*YoloFrame, error) {
	o, err := yoloObjectOf(b, "frame")
	if err != nil {
		return nil, err
	}
	switch t {
	case TYoloLease:
		keyID, _, err1 := o.text("keyId")
		signature, _, err2 := o.text("signature")
		if err1 != nil || err2 != nil || !yoloKeyIDRe.MatchString(keyID) || !yoloSig64Re.MatchString(signature) {
			return nil, errors.New("yolo.lease requires a 32-hex keyId and a 64-byte base64 signature")
		}
		lease, err := ParseYoloLease(o["lease"])
		if err != nil {
			return nil, err
		}
		return &YoloFrame{Lease: &lease, KeyID: keyID, Signature: signature}, nil
	case TYoloRevoke:
		revokedAt, err := o.epoch("revokedAt")
		if err != nil {
			return nil, err
		}
		leaseID, hasLease, err := o.text("leaseId")
		if err != nil {
			return nil, err
		}
		all := false
		if raw, ok := o["all"]; ok && !isNull(raw) {
			if string(bytes.TrimSpace(raw)) != "true" {
				return nil, errors.New("yolo.revoke all must be true when present")
			}
			all = true
		}
		if hasLease == all {
			return nil, errors.New("yolo.revoke requires exactly one of leaseId or all")
		}
		if hasLease && !eventIDRe.MatchString(leaseID) {
			return nil, errors.New("yolo.revoke leaseId must be a UUID")
		}
		return &YoloFrame{LeaseID: leaseID, All: all, RevokedAt: revokedAt}, nil
	case TYoloState:
		items, err := o.list("leases", YoloStateMaxLeases)
		if err != nil {
			return nil, err
		}
		frame := &YoloFrame{Leases: make([]YoloLeaseState, 0, len(items))}
		for _, item := range items {
			state, err := decodeYoloLeaseState(item)
			if err != nil {
				return nil, err
			}
			frame.Leases = append(frame.Leases, state)
		}
		if raw, ok := o["killedAt"]; ok && !isNull(raw) {
			killedAt, err := o.epoch("killedAt")
			if err != nil {
				return nil, err
			}
			frame.KilledAt = &killedAt
		}
		return frame, nil
	case TYoloAudit:
		return decodeYoloAudit(o)
	case TYoloAuditAck:
		toSeq, err := o.epoch("toSeq")
		if err != nil {
			return nil, err
		}
		if toSeq < 1 {
			return nil, errors.New("yolo.audit.ack toSeq must be at least 1")
		}
		return &YoloFrame{ToSeq: uint64(toSeq)}, nil
	}
	return nil, fmt.Errorf("unknown frame type %q", t)
}

func decodeYoloLeaseState(raw json.RawMessage) (YoloLeaseState, error) {
	o, err := yoloObjectOf(raw, "yolo.state lease")
	if err != nil {
		return YoloLeaseState{}, err
	}
	status, _, err := o.text("status")
	if err != nil || (status != YoloActive && status != YoloExpired && status != YoloRevoked && status != YoloRejected) {
		return YoloLeaseState{}, errors.New("yolo.state lease status must be active|expired|revoked|rejected")
	}
	reason, hasReason, err := o.text("reason")
	if err != nil || (hasReason && !yoloCodeRe.MatchString(reason)) {
		return YoloLeaseState{}, errors.New("yolo.state lease reason must be a code")
	}
	leaseID, err := o.uuid("leaseId")
	if err != nil {
		return YoloLeaseState{}, err
	}
	return YoloLeaseState{LeaseID: leaseID, Status: status, Reason: reason}, nil
}

func decodeYoloAudit(o yoloObject) (*YoloFrame, error) {
	runtimeID, _, err := o.text("runtimeId")
	if err != nil || runtimeID == "" || len(utf16Units(runtimeID)) > yoloMaxRuntimeID {
		return nil, errors.New("yolo.audit requires runtimeId")
	}
	items, err := o.list("entries", YoloAuditMaxEntries)
	if err != nil {
		return nil, err
	}
	entries := make([]YoloAuditEntry, 0, len(items))
	for _, item := range items {
		entry, err := decodeYoloAuditEntry(item)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	fromSeq, err := o.epoch("fromSeq")
	if err != nil {
		return nil, err
	}
	toSeq, err := o.epoch("toSeq")
	if err != nil {
		return nil, err
	}
	tail, _, err := o.text("tail")
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 || entries[0].Seq != uint64(fromSeq) || entries[len(entries)-1].Seq != uint64(toSeq) || tail != entries[len(entries)-1].EntryHash {
		return nil, errors.New("yolo.audit requires entries spanning fromSeq..toSeq and ending on tail")
	}
	for i := 1; i < len(entries); i++ {
		if entries[i].Seq != entries[i-1].Seq+1 || entries[i].PrevHash != entries[i-1].EntryHash {
			return nil, errors.New("yolo.audit entries must be contiguous and chained")
		}
	}
	return &YoloFrame{RuntimeID: runtimeID, Entries: entries, FromSeq: uint64(fromSeq), ToSeq: uint64(toSeq), Tail: tail}, nil
}

func decodeYoloAuditEntry(raw json.RawMessage) (YoloAuditEntry, error) {
	o, err := yoloObjectOf(raw, "yolo.audit entry")
	if err != nil {
		return YoloAuditEntry{}, err
	}
	invalid := errors.New("invalid yolo.audit entry")
	seq, err := o.epoch("seq")
	if err != nil {
		return YoloAuditEntry{}, err
	}
	profile, _, err1 := o.text("profile")
	gateKind, _, err2 := o.text("gateKind")
	toolKey, err3 := o.nullableText("toolKey")
	if err1 != nil || err2 != nil || err3 != nil {
		return YoloAuditEntry{}, invalid
	}
	hashes := make([]string, 3)
	for i, key := range []string{"argsHash", "prevHash", "entryHash"} {
		if hashes[i], _, err = o.text(key); err != nil || !yoloHex64Re.MatchString(hashes[i]) {
			return YoloAuditEntry{}, invalid
		}
	}
	if seq < 1 || !yoloProfileRe.MatchString(profile) || !yoloGateKindRe.MatchString(gateKind) || (toolKey != nil && len(utf16Units(*toolKey)) > yoloMaxToolKey) {
		return YoloAuditEntry{}, invalid
	}
	entry := YoloAuditEntry{Seq: uint64(seq), Profile: profile, GateKind: gateKind, ToolKey: toolKey, ArgsHash: hashes[0], PrevHash: hashes[1], EntryHash: hashes[2]}
	if entry.EventID, err = o.uuid("eventId"); err != nil {
		return YoloAuditEntry{}, err
	}
	if entry.OccurredAt, err = o.epoch("occurredAt"); err != nil {
		return YoloAuditEntry{}, err
	}
	if entry.LeaseID, err = o.uuid("leaseId"); err != nil {
		return YoloAuditEntry{}, err
	}
	return entry, nil
}

// validLeaseKeys checks link.context leaseKeys as relay-frames-yolo.ts does:
// shape only. Whether a key may be pinned is the store's decision.
func validLeaseKeys(keys []YoloLeaseKey) error {
	if len(keys) > YoloMaxLeaseKeys {
		return fmt.Errorf("link.context lists %d lease keys, more than %d", len(keys), YoloMaxLeaseKeys)
	}
	for _, key := range keys {
		if !yoloKeyIDRe.MatchString(key.KeyID) || !yoloPub32Re.MatchString(key.PublicKey) {
			return errors.New("link.context lease key requires a 32-hex keyId and a 32-byte base64 publicKey")
		}
		if (key.EndorsedBy == "") != (key.Endorsement == "") ||
			(key.EndorsedBy != "" && (!yoloKeyIDRe.MatchString(key.EndorsedBy) || !yoloSig64Re.MatchString(key.Endorsement))) {
			return errors.New("link.context lease key endorsement requires endorsedBy and a 64-byte base64 endorsement together")
		}
	}
	return nil
}

// EncodeYoloState builds yolo.state; leases is always an array on the wire.
func EncodeYoloState(leases []YoloLeaseState, killedAt *int64) ([]byte, error) {
	if leases == nil {
		leases = []YoloLeaseState{}
	}
	if len(leases) > YoloStateMaxLeases {
		leases = leases[:YoloStateMaxLeases]
	}
	return encodeYolo(struct {
		T        string           `json:"t"`
		Leases   []YoloLeaseState `json:"leases"`
		KilledAt *int64           `json:"killedAt,omitempty"`
	}{TYoloState, leases, killedAt})
}

// EncodeYoloAudit builds yolo.audit over a contiguous, chained slice.
func EncodeYoloAudit(runtimeID string, entries []YoloAuditEntry) ([]byte, error) {
	if len(entries) == 0 || len(entries) > YoloAuditMaxEntries {
		return nil, fmt.Errorf("yolo.audit carries 1..%d entries, not %d", YoloAuditMaxEntries, len(entries))
	}
	last := entries[len(entries)-1]
	return encodeYolo(struct {
		T         string           `json:"t"`
		RuntimeID string           `json:"runtimeId"`
		Entries   []YoloAuditEntry `json:"entries"`
		FromSeq   uint64           `json:"fromSeq"`
		ToSeq     uint64           `json:"toSeq"`
		Tail      string           `json:"tail"`
	}{TYoloAudit, runtimeID, entries, entries[0].Seq, last.Seq, last.EntryHash})
}

func encodeYolo(v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if len(b) > MaxTextFrame {
		return nil, fmt.Errorf("text frame of %d bytes exceeds %d", len(b), MaxTextFrame)
	}
	return b, nil
}
