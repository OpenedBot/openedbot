package connector

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func fileOwner() fsx.Owner { return fsx.Current() }

type leaseVector struct {
	SigningPrefix string          `json:"signingPrefix"`
	TestSeedHex   string          `json:"testSeedHex"`
	PublicKey     string          `json:"publicKey"`
	KeyID         string          `json:"keyId"`
	PinnedKeys    []YoloLeaseKey  `json:"pinnedKeys"`
	RuntimeID     string          `json:"runtimeId"`
	Now           int64           `json:"now"`
	Lease         json.RawMessage `json:"lease"`
	Canonical     string          `json:"canonical"`
	Signature     string          `json:"signature"`
	Invalid       []struct {
		Name      string          `json:"name"`
		KeyID     string          `json:"keyId"`
		Signature string          `json:"signature"`
		Lease     json.RawMessage `json:"lease"`
		Now       int64           `json:"now"`
		Issue     string          `json:"issue"`
	} `json:"invalid"`
}

func readLeaseVector(t *testing.T) leaseVector {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "test", "golden", "yolo-lease", "lease-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v leaseVector
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// verifyReceived is the host's order: strict shape, signature on a pinned
// key, then validity here and now.
func verifyReceived(raw json.RawMessage, keyID, signature string, pinned []YoloLeaseKey, now int64, runtimeID string) error {
	lease, err := ParseYoloLease(raw)
	if err != nil {
		return issue(YoloIssueShape)
	}
	if err := VerifyYoloLeaseSignature(lease, keyID, signature, pinned); err != nil {
		return err
	}
	return ValidateYoloLease(lease, YoloLeaseContext{Now: now, RuntimeID: runtimeID})
}

func TestYoloLeaseVector(t *testing.T) {
	v := readLeaseVector(t)
	if v.SigningPrefix != YoloLeaseSigningPrefix {
		t.Fatalf("prefix %q", v.SigningPrefix)
	}
	seed, _ := hex.DecodeString(v.TestSeedHex)
	key := ed25519.NewKeyFromSeed(seed)
	public := key.Public().(ed25519.PublicKey)
	if base64.StdEncoding.EncodeToString(public) != v.PublicKey || YoloLeaseKeyID(public) != v.KeyID {
		t.Fatal("public key or key id differ from the vector")
	}
	lease, err := ParseYoloLease(v.Lease)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicalJSON(lease)
	if err != nil || string(canonical) != v.Canonical {
		t.Fatalf("canonical differs:\n got %s\nwant %s", canonical, v.Canonical)
	}
	message, _ := YoloLeaseMessage(lease)
	if got := base64.StdEncoding.EncodeToString(ed25519.Sign(key, message)); got != v.Signature {
		t.Fatalf("signature %s, want %s", got, v.Signature)
	}
	if err := verifyReceived(v.Lease, v.KeyID, v.Signature, v.PinnedKeys, v.Now, v.RuntimeID); err != nil {
		t.Fatalf("valid vector refused: %v", err)
	}
	if len(v.Invalid) < 10 {
		t.Fatalf("only %d invalid cases", len(v.Invalid))
	}
	for _, c := range v.Invalid {
		err := verifyReceived(c.Lease, c.KeyID, c.Signature, v.PinnedKeys, c.Now, v.RuntimeID)
		if got := IssueCode(err); got != c.Issue {
			t.Errorf("%s: issue %q (%v), want %q", c.Name, got, err, c.Issue)
		}
	}
}

// signer issues test leases under the public test seed of the vector.
type signer struct {
	key   ed25519.PrivateKey
	keyID string
	pin   YoloLeaseKey
}

func newSigner(seed byte) signer {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = seed + byte(i)
	}
	key := ed25519.NewKeyFromSeed(raw)
	public := key.Public().(ed25519.PublicKey)
	id := YoloLeaseKeyID(public)
	return signer{key: key, keyID: id, pin: YoloLeaseKey{KeyID: id, PublicKey: base64.StdEncoding.EncodeToString(public)}}
}

func (s signer) frame(t *testing.T, lease YoloLease) *YoloFrame {
	t.Helper()
	message, err := YoloLeaseMessage(lease)
	if err != nil {
		t.Fatal(err)
	}
	return &YoloFrame{Lease: &lease, KeyID: s.keyID, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(s.key, message))}
}

func (s signer) endorse(other signer) YoloLeaseKey {
	key := other.pin
	key.EndorsedBy = s.keyID
	key.Endorsement = base64.StdEncoding.EncodeToString(ed25519.Sign(s.key, []byte(YoloKeyEndorsementPrefix+key.KeyID+"\n"+key.PublicKey)))
	return key
}

const testRuntime = "8f3b2c1d-1111-4222-8333-444455556666"

func strp(s string) *string { return &s }

func testLease(id string, scope string, issued int64, duration int64) YoloLease {
	l := YoloLease{V: 1, LeaseID: id, OrganizationID: "0b1f5a8e-3c2d-4e6f-9a7b-1c2d3e4f5a6b", RuntimeID: testRuntime, Scope: scope,
		IssuedAt: issued, NotBefore: issued, ExpiresAt: issued + duration, GrantedBy: "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d",
		Protect: []string{"git_config", "git_hooks", "ssh", "env", "id_rsa", "credentials", "keychain"}}
	l.Deny.Commands, l.Deny.Tools, l.Deny.Paths = []string{}, []string{}, []string{}
	switch scope {
	case "thread":
		l.Profile, l.SessionKey = strp("designer"), strp(strings.Repeat("ab", 32))
	case "bot":
		l.Profile = strp("designer")
	}
	return l
}

type clock struct{ at atomic.Int64 }

func (c *clock) now() time.Time      { return time.Unix(c.at.Load(), 0) }
func (c *clock) set(t int64)         { c.at.Store(t) }
func newClock(t int64) *clock        { c := &clock{}; c.set(t); return c }
func leaseIDs(ls []YoloLease) string { return strings.Join(mapLeases(ls), ",") }
func mapLeases(ls []YoloLease) []string {
	out := make([]string, 0, len(ls))
	for _, l := range ls {
		out = append(out, l.LeaseID[:4])
	}
	return out
}

const (
	leaseA = "aaaaaaaa-0000-4000-8000-000000000001"
	leaseB = "bbbbbbbb-0000-4000-8000-000000000002"
)

func openTestStore(t *testing.T, dir string, c *clock, trusted ...YoloLeaseKey) *YoloStore {
	t.Helper()
	store, err := OpenYoloStore(dir, testRuntime, trusted, c.now, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Stop)
	return store
}

func TestYoloStoreAcceptRefusals(t *testing.T) {
	trusted, other := newSigner(0), newSigner(0x40)
	const now = 1_800_000_000
	cases := []struct {
		name  string
		frame func(t *testing.T) *YoloFrame
		want  string
	}{
		{"valid", func(t *testing.T) *YoloFrame { return trusted.frame(t, testLease(leaseA, "thread", now, 3600)) }, ""},
		{"invalid signature", func(t *testing.T) *YoloFrame {
			f := trusted.frame(t, testLease(leaseA, "bot", now, 3600))
			f.Lease.ExpiresAt++
			return f
		}, YoloIssueSignatureInvalid},
		{"unpinned key", func(t *testing.T) *YoloFrame { return other.frame(t, testLease(leaseA, "bot", now, 3600)) }, YoloIssueKeyUnknown},
		{"another runtime", func(t *testing.T) *YoloFrame {
			l := testLease(leaseA, "runtime", now, 3600)
			l.RuntimeID = "9e8d7c6b-1111-4222-8333-444455556666"
			return trusted.frame(t, l)
		}, YoloIssueRuntimeMismatch},
		{"longer than 24h", func(t *testing.T) *YoloFrame { return trusted.frame(t, testLease(leaseA, "runtime", now, 86401)) }, YoloIssueDurationExceeded},
		{"already expired", func(t *testing.T) *YoloFrame { return trusted.frame(t, testLease(leaseA, "runtime", now-7200, 3600)) }, YoloIssueExpired},
		{"thread without session", func(t *testing.T) *YoloFrame {
			l := testLease(leaseA, "thread", now, 3600)
			l.SessionKey = nil
			return trusted.frame(t, l)
		}, YoloIssueScopeMismatch},
		{"bad deny command", func(t *testing.T) *YoloFrame {
			l := testLease(leaseA, "runtime", now, 3600)
			l.Deny.Commands = []string{"sudo rm"}
			return trusted.frame(t, l)
		}, YoloIssueDenyInvalid},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			store := openTestStore(t, t.TempDir(), newClock(now), trusted.pin)
			err := store.Accept(c.frame(t))
			if got := IssueCode(err); got != c.want || (c.want == "" && err != nil) {
				t.Fatalf("issue %q (%v), want %q", got, err, c.want)
			}
			states, _ := store.State()
			wantStatus := YoloActive
			if c.want != "" {
				wantStatus = YoloRejected
			}
			if len(states) != 1 || states[0].Status != wantStatus || states[0].Reason != c.want {
				t.Fatalf("state %+v", states)
			}
		})
	}
}

func TestYoloStoreFilesArePrivateAndReverified(t *testing.T) {
	dir := t.TempDir()
	key := newSigner(0)
	c := newClock(1_800_000_000)
	store := openTestStore(t, dir, c, key.pin)
	if err := store.Accept(key.frame(t, testLease(leaseA, "bot", c.now().Unix(), 3600))); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{yoloLeasesFile, yoloKeysFile} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", name, err, info)
		}
	}
	// A lease tampered on disk does not survive the next load.
	path := filepath.Join(dir, yoloLeasesFile)
	data, _ := os.ReadFile(path)
	tampered := strings.Replace(string(data), `"expiresAt": 1800003600`, `"expiresAt": 1800080000`, 1)
	if tampered == string(data) {
		t.Fatal("fixture did not change")
	}
	if err := os.WriteFile(path, []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}
	reopened := openTestStore(t, dir, c)
	if active := reopened.Active(); len(active) != 0 {
		t.Fatalf("tampered lease still active: %s", leaseIDs(active))
	}
	// A corrupted file holds nothing, and opening it does not fail the daemon.
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if active := openTestStore(t, dir, c).Active(); len(active) != 0 {
		t.Fatal("corrupted file yielded a lease")
	}
}

func TestYoloStoreRevocationAndReplay(t *testing.T) {
	key := newSigner(0)
	c := newClock(1_800_000_000)
	dir := t.TempDir()
	store := openTestStore(t, dir, c, key.pin)
	frameA := key.frame(t, testLease(leaseA, "bot", c.now().Unix(), 3600))
	if err := store.Accept(frameA); err != nil {
		t.Fatal(err)
	}
	if err := store.Revoke(&YoloFrame{LeaseID: leaseA, RevokedAt: c.now().Unix()}); err != nil {
		t.Fatal(err)
	}
	if len(store.Active()) != 0 {
		t.Fatal("revoked lease still active")
	}
	// The same signed frame replayed, even after a restart, stays refused.
	if err := openTestStore(t, dir, c).Accept(frameA); IssueCode(err) != YoloIssueRevoked {
		t.Fatalf("replay: %v", err)
	}
	// revoke all kills every lease issued up to revokedAt, not a later one.
	c.set(c.now().Unix() + 10)
	if err := store.Accept(key.frame(t, testLease(leaseB, "runtime", c.now().Unix(), 3600))); err != nil {
		t.Fatal(err)
	}
	if err := store.Revoke(&YoloFrame{All: true, RevokedAt: c.now().Unix()}); err != nil {
		t.Fatal(err)
	}
	if len(store.Active()) != 0 {
		t.Fatal("revoke all left a lease")
	}
	later := "cccccccc-0000-4000-8000-000000000003"
	c.set(c.now().Unix() + 10)
	if err := store.Accept(key.frame(t, testLease(later, "runtime", c.now().Unix(), 3600))); err != nil {
		t.Fatalf("a lease issued after revoke all: %v", err)
	}
}

func TestYoloStoreExpiresDuringARun(t *testing.T) {
	key := newSigner(0)
	start := int64(1_800_000_000)
	c := newClock(start)
	store := openTestStore(t, t.TempDir(), c, key.pin)
	if err := store.Accept(key.frame(t, testLease(leaseA, "thread", start, 60))); err != nil {
		t.Fatal(err)
	}
	session := strings.Repeat("ab", 32)
	if store.Lookup("designer", session) == nil {
		t.Fatal("lease does not cover its own session")
	}
	if store.Lookup("designer", strings.Repeat("cd", 32)) != nil || store.Lookup("writer", session) != nil {
		t.Fatal("thread lease covers another session or profile")
	}
	// No timer needed: the next decision reads the clock.
	c.set(start + 60)
	if store.Lookup("designer", session) != nil {
		t.Fatal("lease outlived its expiry")
	}
	states, _ := store.State()
	if len(states) != 1 || states[0].Status != YoloExpired {
		t.Fatalf("state %+v", states)
	}
}

func TestYoloStoreTimerFiresOnExpiry(t *testing.T) {
	key := newSigner(0)
	start := time.Now().Unix()
	store := openTestStore(t, t.TempDir(), newClock(start), key.pin)
	fired := make(chan struct{}, 4)
	store.SetOnChange(func() { fired <- struct{}{} })
	store.mu.Lock()
	store.now = func() time.Time { return time.Unix(start, 0) }
	store.mu.Unlock()
	if err := store.Accept(key.frame(t, testLease(leaseA, "runtime", start, 1))); err != nil {
		t.Fatal(err)
	}
	<-fired // the acceptance itself
	select {
	case <-fired:
	case <-time.After(5 * time.Second):
		t.Fatal("expiry timer never fired")
	}
}

func TestYoloKillRefusesUntilLifted(t *testing.T) {
	key := newSigner(0)
	start := int64(1_800_000_000)
	c := newClock(start)
	dir := t.TempDir()
	store := openTestStore(t, dir, c, key.pin)
	if err := store.Accept(key.frame(t, testLease(leaseA, "runtime", start, 3600))); err != nil {
		t.Fatal(err)
	}
	// `yolo off` with the daemon stopped: only the file is written.
	c.set(start + 5)
	if err := WriteYoloKill(dir, YoloKill{KilledAt: start + 5}, fileOwner()); err != nil {
		t.Fatal(err)
	}
	if len(store.Active()) != 0 {
		t.Fatal("a lease survived yolo off")
	}
	if _, killedAt := store.State(); killedAt == nil || *killedAt != start+5 {
		t.Fatal("yolo.state does not report the kill")
	}
	c.set(start + 10)
	if err := store.Accept(key.frame(t, testLease(leaseB, "runtime", start+10, 3600))); IssueCode(err) != YoloIssueKilled {
		t.Fatalf("a new lease accepted while killed: %v", err)
	}
	// `yolo on` lifts the local refusal for leases issued after the kill only.
	if err := WriteYoloKill(dir, YoloKill{KilledAt: start + 5, LiftedAt: start + 10}, fileOwner()); err != nil {
		t.Fatal(err)
	}
	if err := store.Accept(key.frame(t, testLease(leaseA, "runtime", start, 3600))); IssueCode(err) != YoloIssueKilled {
		t.Fatalf("a lease issued before the kill came back: %v", err)
	}
	if err := store.Accept(key.frame(t, testLease(leaseB, "runtime", start+10, 3600))); err != nil {
		t.Fatalf("lifted: %v", err)
	}
	// An unreadable kill file refuses everything.
	if err := os.WriteFile(filepath.Join(dir, YoloKillFile), []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if len(store.Active()) != 0 {
		t.Fatal("an unreadable kill file let a lease through")
	}
}

func TestYoloKeyPinning(t *testing.T) {
	first, second, rogue := newSigner(0), newSigner(0x20), newSigner(0x60)
	c := newClock(1_800_000_000)
	dir := t.TempDir()
	store := openTestStore(t, dir, c)
	// First use pins what link.context announces.
	if err := store.PinKeys([]YoloLeaseKey{first.pin}); err != nil {
		t.Fatal(err)
	}
	// Afterwards, an unannounced key is refused, an endorsed one is pinned.
	if err := store.PinKeys([]YoloLeaseKey{rogue.pin}); err == nil {
		t.Fatal("a key no pinned key endorses was pinned")
	}
	if err := store.PinKeys([]YoloLeaseKey{first.pin, rogue.endorse(second)}); err == nil {
		t.Fatal("an endorsement by an unpinned key was accepted")
	}
	if err := store.PinKeys([]YoloLeaseKey{first.pin, first.endorse(second)}); err != nil {
		t.Fatalf("endorsed rotation: %v", err)
	}
	// A pinned id never changes key.
	swapped := first.pin
	swapped.PublicKey = rogue.pin.PublicKey
	if err := store.PinKeys([]YoloLeaseKey{swapped}); err == nil {
		t.Fatal("a pinned id took another key")
	}
	reopened := openTestStore(t, dir, c)
	if got := len(reopened.PinnedKeys()); got != 2 {
		t.Fatalf("pinned after reload: %d", got)
	}
	if err := reopened.Accept(second.frame(t, testLease(leaseA, "runtime", c.now().Unix(), 60))); err != nil {
		t.Fatalf("lease on the rotated key: %v", err)
	}
	// A pin file that cannot be read never falls back to a first use.
	if err := os.WriteFile(filepath.Join(dir, yoloKeysFile), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	broken := openTestStore(t, dir, c)
	if err := broken.PinKeys([]YoloLeaseKey{rogue.pin}); err == nil || len(broken.PinnedKeys()) != 0 {
		t.Fatal("a corrupted pin file was replaced by a first use")
	}
}

func TestCoveringLeasePrefersTheNarrowestScope(t *testing.T) {
	session := strings.Repeat("ab", 32)
	runtime := testLease(leaseA, "runtime", 100, 1000)
	bot := testLease(leaseB, "bot", 100, 500)
	thread := testLease("cccccccc-0000-4000-8000-000000000003", "thread", 100, 200)
	all := []YoloLease{runtime, bot, thread}
	if got := CoveringLease(all, "designer", session); got == nil || got.Scope != "thread" {
		t.Fatalf("got %+v", got)
	}
	if got := CoveringLease(all, "designer", ""); got == nil || got.Scope != "bot" {
		t.Fatalf("unknown session: %+v", got)
	}
	if got := CoveringLease(all, "writer", session); got == nil || got.Scope != "runtime" {
		t.Fatalf("other profile: %+v", got)
	}
	if CoveringLease([]YoloLease{bot, thread}, "writer", session) != nil {
		t.Fatal("covered a profile no lease names")
	}
}
