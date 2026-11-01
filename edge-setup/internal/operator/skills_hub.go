package operator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const (
	skillPreviewLimit = 64 << 10
	skillOperationTTL = 7 * 24 * time.Hour
)

var (
	skillIdentifierRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$`)
	skillOperationRe  = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

var skillSources = map[string]bool{
	"all": true, "official": true, "hermes-index": true, "skills-sh": true,
	"url": true, "github": true, "clawhub": true, "lobehub": true, "browse-sh": true,
}

type skillSearchBody struct {
	Query  string `json:"query"`
	Source string `json:"source"`
	Limit  *int   `json:"limit"`
}

type skillInspectBody struct {
	Identifier string `json:"identifier"`
}

type skillHubResult struct {
	Name        string `json:"name"`
	Identifier  string `json:"identifier"`
	Source      string `json:"source"`
	TrustLevel  string `json:"trustLevel"`
	Description string `json:"description"`
}

type skillInspectResult struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Source         string   `json:"source"`
	Identifier     string   `json:"identifier"`
	Tags           []string `json:"tags"`
	SkillMDPreview *string  `json:"skillMdPreview"`
}

type skillScanResult struct {
	TrustLevel string         `json:"trustLevel"`
	Source     string         `json:"source"`
	Verdict    string         `json:"verdict"`
	Policy     string         `json:"policy"`
	Findings   []skillFinding `json:"findings"`
}

type skillFinding struct {
	Severity    string  `json:"severity"`
	Category    string  `json:"category"`
	Description string  `json:"description"`
	File        *string `json:"file"`
	Line        *int    `json:"line"`
}

type skillOperationError struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

type skillOperation struct {
	OperationID string               `json:"operationId"`
	Profile     string               `json:"profile"`
	Identifier  string               `json:"identifier"`
	State       string               `json:"state"`
	Error       *skillOperationError `json:"error"`
	Skills      []string             `json:"skills"`
	CreatedAt   time.Time            `json:"-"`
}

type skillOperationDisk struct {
	OperationID string               `json:"operationId"`
	Profile     string               `json:"profile"`
	Identifier  string               `json:"identifier"`
	State       string               `json:"state"`
	Error       *skillOperationError `json:"error"`
	Skills      []string             `json:"skills"`
	CreatedAt   time.Time            `json:"createdAt"`
}

func (s *Server) skillsHubEnabled() bool {
	if s.Probe == nil {
		return false
	}
	if s.SkillsHubReady {
		return true
	}
	s.skillsHubOnce.Do(func() {
		s.skillsHubProbed = s.probeSkillsHub(context.Background())
		if s.skillsHubProbed {
			// The features are first listed at the connector's hello, so this
			// warms the hub indexes right after a start, an install or an
			// upgrade, before anyone searches.
			s.refreshSkillsHubIndexes()
		}
	})
	return s.skillsHubProbed
}

// skillsHubRefreshInterval bounds how often a search re-triggers the
// background refresh. A refresh whose indexes are still fresh is local work;
// past the upstream TTL it downloads them.
const skillsHubRefreshInterval = 15 * time.Minute

type skillsHubRefresher struct {
	mu      sync.Mutex
	running bool
	// warmed is set once a refresh has completed: from then on the cache is
	// on disk and a search serves it, even while a later refresh runs.
	warmed bool
	last   time.Time
	done   chan struct{}
}

// skillsHubRefreshWait bounds how long a search waits for a refresh in
// flight: under the API's 35 s read budget, with room for the search itself.
const skillsHubRefreshWait = 25 * time.Second

// awaitSkillsHubRefresh lets a search that arrives during the warm-up read
// the indexes once built, instead of downloading the same indexes in
// parallel. Every request comes over the link after its hello, which started
// the warm-up, so a first search after an install or a start lands here
// rather than on an empty cache. Once a refresh has completed, the cached
// indexes serve every search at once: a periodic refresh never holds one.
func (s *Server) awaitSkillsHubRefresh(ctx context.Context) {
	r := &s.skillsHubRefresh
	r.mu.Lock()
	done, running, warmed := r.done, r.running, r.warmed
	r.mu.Unlock()
	if warmed || !running || done == nil {
		return
	}
	timer := time.NewTimer(skillsHubRefreshWait)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	case <-ctx.Done():
	}
}

// refreshSkillsHubIndexes refetches the upstream hub indexes in the
// background. Searches serve whatever index is cached (the probe lifts the
// upstream TTLs in the foreground), so a cold or expired cache never puts a
// download on a user's request: this refresh is what keeps them current.
func (s *Server) refreshSkillsHubIndexes() {
	if s.Probe == nil {
		return
	}
	now := s.now()
	r := &s.skillsHubRefresh
	r.mu.Lock()
	if r.running || (!r.last.IsZero() && now.Sub(r.last) < skillsHubRefreshInterval) {
		r.mu.Unlock()
		return
	}
	r.running, r.last = true, now
	done := make(chan struct{})
	r.done = done
	r.mu.Unlock()
	go func() {
		refreshed := false
		defer func() {
			r.mu.Lock()
			r.running = false
			r.warmed = r.warmed || refreshed
			r.mu.Unlock()
			close(done)
		}()
		ctx, cancel := context.WithTimeout(context.Background(), probeTimeout("skills-hub-refresh"))
		defer cancel()
		if _, err := s.invokeProbe(ctx, "skills-hub-refresh", nil); err != nil {
			s.logf("skills hub index refresh failed; searches keep serving the cached indexes")
			return
		}
		refreshed = true
	}()
}

func (s *Server) probeSkillsHub(ctx context.Context) bool {
	if s.Probe == nil {
		return false
	}
	var result struct {
		Available bool `json:"available"`
	}
	if err := s.runFreshProbe(ctx, "skills-hub-capabilities", nil, &result); err != nil {
		return false
	}
	return result.Available
}

func (s *Server) skillOperationDir() string {
	if s.SkillsOperationDir != "" {
		return s.SkillsOperationDir
	}
	return filepath.Join(layout.OperatorStateDir, "skills-hub-operations")
}

func (s *Server) loadSkillOperationsLocked() {
	if s.skillOps != nil {
		return
	}
	s.skillOps = map[string]*skillOperation{}
	entries, err := os.ReadDir(s.skillOperationDir())
	if err != nil {
		return
	}
	now := s.now()
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !skillOperationRe.MatchString(id) {
			continue
		}
		path := filepath.Join(s.skillOperationDir(), entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var disk skillOperationDisk
		if json.Unmarshal(raw, &disk) != nil || disk.OperationID != id {
			continue
		}
		op := skillOperation(disk)
		if op.CreatedAt.IsZero() {
			op.CreatedAt = now
		}
		if now.Sub(op.CreatedAt) > skillOperationTTL {
			_ = os.Remove(path)
			continue
		}
		if op.State == "running" {
			op.State = "failed"
			op.Error = &skillOperationError{Code: "OPERATION_INTERRUPTED", Detail: "the operator restarted while this operation was running"}
			_ = s.persistSkillOperationLocked(&op)
		}
		s.skillOps[op.OperationID] = &op
	}
}

func (s *Server) persistSkillOperationLocked(op *skillOperation) error {
	if err := os.MkdirAll(s.skillOperationDir(), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(skillOperationDisk{OperationID: op.OperationID, Profile: op.Profile, Identifier: op.Identifier, State: op.State, Error: op.Error, Skills: op.Skills, CreatedAt: op.CreatedAt})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.skillOperationDir(), op.OperationID+".json"), payload, 0o600)
}

func newSkillOperationID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(b)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}

func validSkillIdentifier(value string) bool {
	return len(value) >= 1 && len(value) <= 200 && skillIdentifierRe.MatchString(value) && !strings.Contains(value, "..") && !strings.Contains(value, "//") &&
		!strings.Contains(value, ":") && !strings.ContainsAny(value, " \t\r\n\v\f") && !hasControl(value)
}

func validSkillQuery(value string) bool {
	if len(value) < 1 || len(value) > 100 {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func readStrictJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(raw) > MaxBody {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is missing or too large")
		return false
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body contains invalid or unknown fields")
		return false
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body contains trailing data")
		return false
	}
	return true
}

func (s *Server) validateSkillIdentifier(w http.ResponseWriter, identifier string) bool {
	if validSkillIdentifier(identifier) {
		return true
	}
	writeError(w, http.StatusBadRequest, "SKILL_IDENTIFIER_INVALID", "the skill identifier must be a bounded source/name registry identifier")
	return false
}

func (s *Server) skillsSearch(w http.ResponseWriter, r *http.Request) {
	if !s.skillsHubEnabled() {
		http.NotFound(w, r)
		return
	}
	var body skillSearchBody
	if !readStrictJSON(w, r, &body) || !validSkillQuery(body.Query) {
		writeError(w, http.StatusBadRequest, "SKILL_QUERY_INVALID", "query must be 1-100 printable characters")
		return
	}
	source := body.Source
	if source == "" {
		source = "all"
	}
	if !skillSources[source] || source == "well-known" {
		writeError(w, http.StatusBadRequest, "SKILL_SOURCE_INVALID", "source is not an upstream skills hub source")
		return
	}
	limit := 10
	if body.Limit != nil {
		limit = *body.Limit
	}
	if limit < 1 || limit > 25 {
		writeError(w, http.StatusBadRequest, "SKILL_LIMIT_INVALID", "limit must be between 1 and 25")
		return
	}
	s.awaitSkillsHubRefresh(r.Context())
	var result []skillHubResult
	if err := s.runProbe(r.Context(), "skills-hub-search", map[string]any{"query": body.Query, "source": source, "limit": limit}, &result); err != nil {
		s.writeProbeFailure(w, "skills-hub-search", err)
		return
	}
	if result == nil {
		result = []skillHubResult{}
	}
	writeJSON(w, http.StatusOK, result)
	s.refreshSkillsHubIndexes()
}

func (s *Server) skillsInspect(w http.ResponseWriter, r *http.Request) {
	if !s.skillsHubEnabled() {
		http.NotFound(w, r)
		return
	}
	var body skillInspectBody
	if !readStrictJSON(w, r, &body) || !s.validateSkillIdentifier(w, body.Identifier) {
		return
	}
	var result skillInspectResult
	s.awaitSkillsHubRefresh(r.Context())
	if err := s.runProbe(r.Context(), "skills-hub-inspect", body, &result); err != nil {
		s.writeProbeFailure(w, "skills-hub-inspect", err)
		return
	}
	if result.SkillMDPreview != nil && len([]byte(*result.SkillMDPreview)) > skillPreviewLimit {
		clipped := string([]byte(*result.SkillMDPreview)[:skillPreviewLimit])
		result.SkillMDPreview = &clipped
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) skillsScan(w http.ResponseWriter, r *http.Request) {
	if !s.skillsHubEnabled() {
		http.NotFound(w, r)
		return
	}
	profile := r.PathValue("slug")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name is invalid")
		return
	}
	var body skillInspectBody
	if !readStrictJSON(w, r, &body) || !s.validateSkillIdentifier(w, body.Identifier) {
		return
	}
	var result skillScanResult
	if err := s.runProbe(r.Context(), "skills-hub-scan", map[string]any{"identifier": body.Identifier, "profile": profile}, &result); err != nil {
		s.writeProbeFailure(w, "skills-hub-scan", err)
		return
	}
	if err := validateSkillScan(result); err != nil {
		writeError(w, http.StatusBadGateway, "SKILL_SCAN_FAILED", "the host returned an invalid skill scan")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) installSkill(w http.ResponseWriter, r *http.Request) {
	if !s.skillsHubEnabled() {
		http.NotFound(w, r)
		return
	}
	profile := r.PathValue("slug")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name is invalid")
		return
	}
	var body skillInspectBody
	if !readStrictJSON(w, r, &body) || !s.validateSkillIdentifier(w, body.Identifier) {
		return
	}
	s.mu.Lock()
	s.loadSkillOperationsLocked()
	for _, op := range s.skillOps {
		if op.Profile == profile && (op.State == "queued" || op.State == "running") {
			s.mu.Unlock()
			writeError(w, http.StatusConflict, "SKILL_OPERATION_IN_PROGRESS", "a skill operation is already running for this profile")
			return
		}
	}
	op := &skillOperation{OperationID: newSkillOperationID(), Profile: profile, Identifier: body.Identifier, State: "queued", CreatedAt: s.now()}
	s.skillOps[op.OperationID] = op
	err := s.persistSkillOperationLocked(op)
	s.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusBadGateway, "HOST_UNAVAILABLE", "the skill operation could not be persisted")
		return
	}
	go s.runSkillInstall(op)
	writeJSON(w, http.StatusAccepted, map[string]string{"operationId": op.OperationID})
}

func (s *Server) runSkillInstall(op *skillOperation) {
	s.mu.Lock()
	op.State = "running"
	_ = s.persistSkillOperationLocked(op)
	s.mu.Unlock()
	finish := func(state, code, detail string, skills []string) {
		s.mu.Lock()
		op.State = state
		op.Skills = skills
		if code != "" {
			op.Error = &skillOperationError{Code: code, Detail: detail}
		}
		_ = s.persistSkillOperationLocked(op)
		s.mu.Unlock()
	}
	var scan skillScanResult
	if err := s.runProbe(context.Background(), "skills-hub-scan", map[string]any{"identifier": op.Identifier, "profile": op.Profile}, &scan); err != nil {
		finish("failed", "SKILL_SCAN_FAILED", "the fresh skill scan could not be completed", nil)
		return
	}
	if err := validateSkillScan(scan); err != nil {
		finish("failed", "SKILL_SCAN_FAILED", "the fresh skill scan returned an invalid response", nil)
		return
	}
	if scan.Policy != "allow" || scan.Verdict == "dangerous" {
		finish("failed", "SKILL_SCAN_BLOCKED", "the fresh skill scan did not allow installation", nil)
		return
	}
	if scan.Source != "official" && scan.TrustLevel != "builtin" && scan.TrustLevel != "trusted" {
		finish("failed", "SKILL_TRUST_REFUSED", "the skill provenance is not official or verified", nil)
		return
	}
	if err := s.runProbe(context.Background(), "skills-hub-install", map[string]any{"identifier": op.Identifier, "profile": op.Profile}, nil); err != nil {
		finish("failed", "SKILL_INSTALL_FAILED", "the upstream skill install failed", nil)
		return
	}
	doc, err := s.profileDocument(context.Background())
	if err != nil {
		finish("failed", "SKILL_INSTALL_UNVERIFIED", "the profile skills could not be read back", nil)
		return
	}
	row, ok := profileByName(doc.Profiles, op.Profile)
	if !ok {
		finish("failed", "SKILL_INSTALL_UNVERIFIED", "the profile was not present after installation", nil)
		return
	}
	skills := make([]string, 0, len(row.Skills))
	found := false
	for _, skill := range row.Skills {
		skills = append(skills, skill.Name)
		if skill.Name == skillName(op.Identifier) {
			found = true
		}
	}
	if !found {
		finish("failed", "SKILL_INSTALL_UNVERIFIED", "the installed skill was missing from the profile inventory", skills)
		return
	}
	finish("succeeded", "", "", skills)
}

func skillName(identifier string) string {
	return identifier[strings.LastIndexByte(identifier, '/')+1:]
}

func (s *Server) getSkillOperation(w http.ResponseWriter, r *http.Request) {
	if !s.skillsHubEnabled() {
		http.NotFound(w, r)
		return
	}
	profile := r.PathValue("slug")
	id := r.PathValue("uuid")
	if !profileSlugRe.MatchString(profile) || profile == "default" || !skillOperationRe.MatchString(id) {
		writeError(w, http.StatusNotFound, "SKILL_OPERATION_NOT_FOUND", "this skill operation no longer exists")
		return
	}
	s.mu.Lock()
	s.loadSkillOperationsLocked()
	op := s.skillOps[id]
	s.mu.Unlock()
	if op == nil || op.Profile != profile {
		writeError(w, http.StatusNotFound, "SKILL_OPERATION_NOT_FOUND", "this skill operation no longer exists")
		return
	}
	writeJSON(w, http.StatusOK, op)
}

func (s *Server) deleteSkill(w http.ResponseWriter, r *http.Request) {
	if !s.skillsHubEnabled() {
		http.NotFound(w, r)
		return
	}
	profile, skill := r.PathValue("slug"), r.PathValue("skill")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name is invalid")
		return
	}
	if !skillRe.MatchString(skill) {
		writeError(w, http.StatusBadRequest, "SKILL_INVALID", "the skill name is invalid")
		return
	}
	if err := s.runProbe(r.Context(), "skills-hub-uninstall", map[string]any{"profile": profile, "skill": skill}, nil); err != nil {
		s.writeProbeFailure(w, "skills-hub-uninstall", err)
		return
	}
	doc, err := s.profileDocument(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "SKILL_UNVERIFIED", "the skill was removed but the profile inventory could not be read back")
		return
	}
	row, ok := profileByName(doc.Profiles, profile)
	if !ok {
		writeError(w, http.StatusBadGateway, "SKILL_UNVERIFIED", "the profile was missing after skill removal")
		return
	}
	skills := make([]string, 0, len(row.Skills))
	removed := true
	for _, item := range row.Skills {
		skills = append(skills, item.Name)
		if item.Name == skill {
			removed = false
		}
	}
	if !removed {
		writeError(w, http.StatusBadGateway, "SKILL_UNINSTALL_UNVERIFIED", "the skill was still present after removal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": profile, "skill": skill, "skills": skills})
}

func validateSkillScan(result skillScanResult) error {
	if result.Source == "" || result.TrustLevel == "" {
		return errors.New("skill scan provenance is missing")
	}
	if result.Verdict != "safe" && result.Verdict != "caution" && result.Verdict != "dangerous" {
		return errors.New("skill scan verdict is invalid")
	}
	if result.Policy != "allow" && result.Policy != "ask" && result.Policy != "block" {
		return errors.New("skill scan policy is invalid")
	}
	if len(result.Findings) > 128 {
		return errors.New("skill scan findings are too numerous")
	}
	for _, finding := range result.Findings {
		if finding.Severity != "critical" && finding.Severity != "high" && finding.Severity != "medium" && finding.Severity != "low" {
			return errors.New("skill scan finding severity is invalid")
		}
		if !boundedSkillString(finding.Category) || !boundedSkillString(finding.Description) {
			return errors.New("skill scan finding text is invalid")
		}
		if finding.File != nil && !boundedSkillString(*finding.File) {
			return errors.New("skill scan finding file is invalid")
		}
		if finding.Line != nil && (*finding.Line < 0 || *finding.Line > 1_000_000_000) {
			return errors.New("skill scan finding line is invalid")
		}
	}
	return nil
}

func boundedSkillString(value string) bool {
	return value != "" && len(value) <= 1_000
}
