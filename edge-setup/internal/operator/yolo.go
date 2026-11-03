package operator

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/yolohardline"
)

// The profile half of YOLO mode (docs/CONNECTOR.md, « Bail YOLO »). The
// connector verifies a lease, then asks here, over the operator socket, to
// write the yolo.json of every profile it covers next to the approval
// plugin; the plugin reads it on every tool call. The plugin appends each
// auto-approval to yolo-audit.jsonl in the same directory, which the
// connector collects here (it cannot read the runtime root itself).
//
// Owners copy policy.json's: the Hermes service owner, 0600, in the plugin
// directory. Only root and the connector unit reach these routes (PeerPolicy);
// they are not in the relay allowlist, so openedbot never calls them.
const (
	yoloFile          = "yolo.json"
	yoloHardlineFile  = "hardline.json"
	yoloSpoolFile     = "yolo-audit.jsonl"
	yoloDrainingFile  = "yolo-audit.draining.jsonl"
	yoloMaxLeases     = 64
	yoloMaxRecords    = 4096
	yoloMaxSpoolBytes = 4 << 20
	// yoloMaxBody bounds PUT /yolo: 64 leases with full deny-lists.
	yoloMaxBody       = 4 << 20
	yoloFeature       = "yolo_lease"
	yoloThreadFeature = "yolo_thread_scope"
)

var (
	yoloUUIDRe     = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	yoloHex64Re    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	yoloGateKindRe = regexp.MustCompile(`^[a-z_]{1,32}$`)
)

// yoloApplied is one lease as the plugin reads it.
type yoloApplied struct {
	LeaseID    string            `json:"leaseId"`
	Scope      string            `json:"scope"`
	Profile    *string           `json:"profile"`
	SessionKey *string           `json:"sessionKey"`
	NotBefore  int64             `json:"notBefore"`
	ExpiresAt  int64             `json:"expiresAt"`
	Deny       yolohardline.Deny `json:"deny"`
	Protect    []string          `json:"protect"`
}

func (l yoloApplied) valid() bool {
	scoped := false
	switch l.Scope {
	case "thread":
		scoped = l.Profile != nil && l.SessionKey != nil && yoloHex64Re.MatchString(*l.SessionKey)
	case "bot":
		scoped = l.Profile != nil && l.SessionKey == nil
	case "runtime":
		scoped = l.Profile == nil && l.SessionKey == nil
	}
	if !scoped || !yoloUUIDRe.MatchString(l.LeaseID) || (l.Profile != nil && (!profileSlugRe.MatchString(*l.Profile) || *l.Profile == "default")) ||
		l.ExpiresAt <= l.NotBefore || len(l.Protect) == 0 || len(l.Protect) > 32 {
		return false
	}
	for _, id := range l.Protect {
		if !yolohardline.IsProtectionID(id) {
			return false
		}
	}
	for _, list := range [][]string{l.Deny.Commands, l.Deny.Tools, l.Deny.Paths} {
		if len(list) > 50 || slices.ContainsFunc(list, func(s string) bool { return s == "" || len(s) > 1024 }) {
			return false
		}
	}
	return true
}

func (l yoloApplied) covers(slug string) bool {
	return l.Scope == "runtime" || (l.Profile != nil && *l.Profile == slug)
}

type yoloDocument struct {
	V      int           `json:"v"`
	Leases []yoloApplied `json:"leases"`
}

// yoloSpoolRecord is one line of a plugin spool, plus its profile.
type yoloSpoolRecord struct {
	Profile    string  `json:"profile"`
	EventID    string  `json:"eventId"`
	OccurredAt int64   `json:"occurredAt"`
	LeaseID    string  `json:"leaseId"`
	GateKind   string  `json:"gateKind"`
	ToolKey    *string `json:"toolKey"`
	ArgsHash   string  `json:"argsHash"`
}

// yoloService works on the plugin directories of the runtime root.
type yoloService struct {
	runtimeRoot string
	owner       fsx.Owner
	logf        func(string, ...any)
}

func (y yoloService) log(format string, args ...any) {
	if y.logf != nil {
		y.logf(format, args...)
	}
}

// pluginDirs lists the profiles whose approval plugin directory is safe to
// write: real directories owned by the service owner, no symlink on the way.
func (y yoloService) pluginDirs() (map[string]string, error) {
	p := approvalPolicyService{runtimeRoot: y.runtimeRoot, owner: y.owner}
	matches, err := filepath.Glob(filepath.Join(y.runtimeRoot, "profiles", "*", "plugins", approvalPolicyPlugin))
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, dir := range matches {
		slug := filepath.Base(filepath.Dir(filepath.Dir(dir)))
		if p.validateProfile(slug) != nil {
			continue
		}
		safe := true
		for _, path := range []string{filepath.Join(y.runtimeRoot, "profiles", slug), filepath.Join(y.runtimeRoot, "profiles", slug, "plugins"), dir} {
			st, err := fsx.Lstat(path)
			if err != nil || !st.Exists || !st.Dir || st.Symlink || st.Owner != y.owner {
				safe = false
			}
		}
		if safe {
			out[slug] = dir
		}
	}
	return out, nil
}

// apply writes the leases covering each profile and removes yolo.json where
// none does. Every profile is attempted; the first failure is returned.
func (y yoloService) apply(_ context.Context, leases []yoloApplied) error {
	dirs, err := y.pluginDirs()
	if err != nil {
		return err
	}
	var failed error
	for slug, dir := range dirs {
		var covering []yoloApplied
		for _, l := range leases {
			if l.covers(slug) {
				covering = append(covering, l)
			}
		}
		target := filepath.Join(dir, yoloFile)
		if len(covering) == 0 {
			if err := fsx.Remove(target); err != nil && failed == nil {
				failed = fmt.Errorf("profile %s: %w", slug, err)
			}
			continue
		}
		// The rules the plugin applies ride with the leases: data, read at
		// every call, so a plugin loaded earlier sees them without a reload.
		if err := writeIfChanged(filepath.Join(dir, yoloHardlineFile), yolohardline.JSON, y.owner); err != nil && failed == nil {
			failed = fmt.Errorf("profile %s: %w", slug, err)
			continue
		}
		data, _ := json.Marshal(yoloDocument{V: 1, Leases: covering})
		if err := fsx.WriteAtomic(target, append(data, '\n'), 0o600, y.owner); err != nil && failed == nil {
			failed = fmt.Errorf("profile %s: %w", slug, err)
		}
	}
	return failed
}

func writeIfChanged(path string, data []byte, owner fsx.Owner) error {
	st, err := fsx.Lstat(path)
	if err != nil || (st.Exists && (st.Symlink || !st.Regular || st.Owner != owner)) {
		return errors.New("plugin file is unsafe")
	}
	if st.Exists {
		if old, err := os.ReadFile(path); err == nil && string(old) == string(data) {
			return nil
		}
	}
	return fsx.WriteAtomic(path, data, 0o600, owner)
}

// drain hands out the plugin spools. Each spool is renamed to its draining
// name under the plugin's own lock, so a write in progress lands before the
// rename; a draining file left by an unacknowledged drain is handed out
// again (the connector recognizes records by their event id).
func (y yoloService) drain(_ context.Context) ([]yoloSpoolRecord, error) {
	dirs, err := y.pluginDirs()
	if err != nil {
		return nil, err
	}
	slugs := make([]string, 0, len(dirs))
	for slug := range dirs {
		slugs = append(slugs, slug)
	}
	slices.Sort(slugs)
	var out []yoloSpoolRecord
	for _, slug := range slugs {
		dir := dirs[slug]
		draining := filepath.Join(dir, yoloDrainingFile)
		if st, err := fsx.Lstat(draining); err != nil || !st.Exists {
			if err := y.claimSpool(dir); err != nil {
				y.log("yolo spool of %s could not be claimed: %v", slug, err)
				continue
			}
		}
		records, skipped, err := y.readSpool(draining, slug, yoloMaxRecords-len(out))
		if err != nil {
			y.log("yolo spool of %s could not be read: %v", slug, err)
			continue
		}
		if skipped > 0 {
			y.log("yolo spool of %s: %d invalid lines ignored", slug, skipped)
		}
		out = append(out, records...)
		if len(out) >= yoloMaxRecords {
			break
		}
	}
	return out, nil
}

func (y yoloService) claimSpool(dir string) error {
	spool := filepath.Join(dir, yoloSpoolFile)
	st, err := fsx.Lstat(spool)
	if err != nil || !st.Exists {
		return err
	}
	if st.Symlink || !st.Regular || st.Owner != y.owner {
		return errors.New("spool is unsafe")
	}
	f, err := os.OpenFile(spool, os.O_RDWR|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	return os.Rename(spool, filepath.Join(dir, yoloDrainingFile))
}

func (y yoloService) readSpool(path, slug string, room int) ([]yoloSpoolRecord, int, error) {
	st, err := fsx.Lstat(path)
	if err != nil || !st.Exists {
		return nil, 0, err
	}
	if st.Symlink || !st.Regular || st.Owner != y.owner {
		return nil, 0, errors.New("draining spool is unsafe")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	var out []yoloSpoolRecord
	skipped := 0
	scanner := bufio.NewScanner(io.LimitReader(f, yoloMaxSpoolBytes))
	for scanner.Scan() && len(out) < room {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var r struct {
			V int `json:"v"`
			yoloSpoolRecord
		}
		if json.Unmarshal([]byte(line), &r) != nil || r.V != 1 || !yoloUUIDRe.MatchString(r.EventID) || !yoloUUIDRe.MatchString(r.LeaseID) ||
			!yoloGateKindRe.MatchString(r.GateKind) || !yoloHex64Re.MatchString(r.ArgsHash) || r.OccurredAt <= 0 ||
			(r.ToolKey != nil && (*r.ToolKey == "" || len(*r.ToolKey) > 256)) {
			skipped++
			continue
		}
		r.Profile = slug
		out = append(out, r.yoloSpoolRecord)
	}
	return out, skipped, scanner.Err()
}

// drained removes the draining spools the last drain handed out.
func (y yoloService) drained(_ context.Context) error {
	dirs, err := y.pluginDirs()
	if err != nil {
		return err
	}
	var failed error
	for _, dir := range dirs {
		if err := fsx.Remove(filepath.Join(dir, yoloDrainingFile)); err != nil && failed == nil {
			failed = err
		}
	}
	return failed
}

func yoloApplyHandler(apply func(context.Context, []yoloApplied) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if apply == nil {
			writeError(w, http.StatusServiceUnavailable, "YOLO_UNAVAILABLE", "YOLO leases cannot be applied on this host")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, yoloMaxBody+1))
		var request struct {
			Leases []yoloApplied `json:"leases"`
		}
		decoder := json.NewDecoder(strings.NewReader(string(body)))
		decoder.DisallowUnknownFields()
		decodeErr := decoder.Decode(&request)
		if err != nil || len(body) > yoloMaxBody || decodeErr != nil || decoder.Decode(new(any)) != io.EOF || request.Leases == nil ||
			len(request.Leases) > yoloMaxLeases || slices.ContainsFunc(request.Leases, func(l yoloApplied) bool { return !l.valid() }) {
			writeError(w, http.StatusBadRequest, "BODY_INVALID", "the YOLO lease set is invalid")
			return
		}
		if err := apply(r.Context(), request.Leases); err != nil {
			writeError(w, http.StatusBadGateway, "YOLO_APPLY_FAILED", "the YOLO lease set could not be written to every profile")
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"leases": len(request.Leases)})
	}
}

func yoloDrainHandler(drain func(context.Context) ([]yoloSpoolRecord, error), drained func(context.Context) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if drain == nil || drained == nil {
			writeError(w, http.StatusServiceUnavailable, "YOLO_UNAVAILABLE", "the YOLO audit is not collected on this host")
			return
		}
		if r.Method == http.MethodDelete {
			if err := drained(r.Context()); err != nil {
				writeError(w, http.StatusBadGateway, "YOLO_DRAIN_FAILED", "the collected YOLO audit could not be removed")
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"drained": true})
			return
		}
		records, err := drain(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, "YOLO_DRAIN_FAILED", "the YOLO audit could not be collected")
			return
		}
		if records == nil {
			records = []yoloSpoolRecord{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"records": records})
	}
}
