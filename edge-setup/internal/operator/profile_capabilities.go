package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"

	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type profileToolsetToggleBody struct {
	Enabled *bool `json:"enabled"`
}

// memoryToolset is the one toolset whose availability also depends on the
// profile's `memory` config section (see setProfileToolset).
const memoryToolset = "memory"

type profileMemoryState struct {
	Profile            string `json:"profile"`
	MemoryEnabled      bool   `json:"memoryEnabled"`
	UserProfileEnabled bool   `json:"userProfileEnabled"`
}

func (s *Server) setProfileToolset(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	name := r.PathValue("toolset")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	if !toolsetRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, "TOOLSET_INVALID", "the toolset name is invalid")
		return
	}
	var body profileToolsetToggleBody
	raw, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(raw) > MaxBody {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is missing or too large")
		return
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.Enabled == nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the body must be {\"enabled\": true|false}")
		return
	}
	wanted := *body.Enabled
	if name == "a2a" && wanted && !s.a2aToolsetGuardAvailable(r.Context()) {
		writeError(w, http.StatusForbidden, "A2A_POLICY_UNAVAILABLE", "the managed A2A toolset requires the observed peer policy guard")
		return
	}
	if pins.ToolsetIsForbidden(name, true) && wanted {
		writeError(w, http.StatusForbidden, "TOOLSET_FORBIDDEN",
			name+" runs work outside the run openedbot leases and journals; it stays off on this host")
		return
	}

	var doc ToolsetsDocument
	if err := s.runProbe(r.Context(), "toolsets", nil, &doc); err != nil {
		s.writeProbeFailure(w, "toolsets", err)
		return
	}
	if !slices.Contains(doc.Settable, name) {
		writeError(w, http.StatusNotFound, "TOOLSET_NOT_SETTABLE",
			"this host does not offer "+name+" on the "+toolsetPlatform+" platform")
		return
	}
	if !s.toolsetBusy.TryLock() {
		writeError(w, http.StatusConflict, "TOOLSET_IN_PROGRESS", "a toolset change is already running; retry once it completes")
		return
	}
	defer s.toolsetBusy.Unlock()
	// A profile toolset write changes that profile only (inventory.go).
	defer s.dropProfileReadCache()

	verb := "disable"
	if wanted {
		verb = "enable"
	}
	ctx, cancel := context.WithTimeout(r.Context(), ToolsetTimeout)
	defer cancel()
	cmd := s.hermesCommand("-p", profile, "tools", verb, name, "--platform", toolsetPlatform)
	cmd.Timeout = ToolsetTimeout
	if err := s.runConfigWriter(ctx, profile, cmd); err != nil {
		s.logf("profile toolset %s %s refused by the CLI", profile, name)
		writeError(w, http.StatusBadGateway, "CLI_REFUSED", "the runtime refused the profile toolset change")
		return
	}
	// The `memory` toolset is gated a second time by the profile's
	// `memory.memory_enabled` / `user_profile_enabled` flags (forced to false
	// at the root by `up`, cloned into every profile). The toolset entry alone
	// never reaches a run; both flags follow the toggle, on this profile only.
	if name == memoryToolset {
		var memoryState profileMemoryState
		request := map[string]any{"name": profile, "enabled": wanted}
		if err := s.runProbe(ctx, "profile-memory-set", request, &memoryState); err != nil {
			s.writeProbeFailure(w, "profile-memory-set", err)
			return
		}
	}
	enabled, err := s.readBackProfileToolset(ctx, profile, name, wanted)
	if err != nil {
		writeError(w, http.StatusBadGateway, "TOOLSET_UNVERIFIED",
			"the change was written but the profile inventory could not be read back")
		return
	}
	writeJSON(w, http.StatusOK, ToolsetState{
		Name: name, Profile: profile, Platform: toolsetPlatform,
		Enabled: enabled, Requested: wanted, Applied: enabled == wanted,
	})
}

// readBackProfileToolset reads one toolset of the profile after its write.
// When the platform list did not move it, upstream turns `x_search` back on
// under an empty list when xAI credentials exist: the profile's
// `agent.disabled_toolsets` decides last, and the root's suppression is never
// lifted from here (inventory_probe.py). A refused suppression keeps the
// honest answer: `applied` false.
func (s *Server) readBackProfileToolset(ctx context.Context, profile, name string, wanted bool) (bool, error) {
	enabled, err := s.profileToolsetEnabled(ctx, profile, name)
	if err == nil && enabled != wanted {
		request := map[string]any{"name": profile, "toolset": name, "suppressed": !wanted}
		if probeErr := s.runProbe(ctx, "profile-toolset-suppress", request, nil); probeErr != nil {
			s.logf("profile toolset %s %s suppression refused", profile, name)
		} else {
			enabled, err = s.profileToolsetEnabled(ctx, profile, name)
		}
	}
	return enabled, err
}

func (s *Server) profileToolsetEnabled(ctx context.Context, profile, name string) (bool, error) {
	body, err := s.profileToolsetDocument(ctx, profile)
	if err != nil {
		return false, err
	}
	return gateway.ToolsetEnabled(body, name)
}

// profileToolsetDocument is the gateway's toolset inventory of the profile,
// or of the root on a host without per-profile reads.
func (s *Server) profileToolsetDocument(ctx context.Context, profile string) ([]byte, error) {
	if s.ProfileInventory != nil {
		return s.ProfileInventory(ctx, profile)
	}
	if s.Inventory == nil {
		return nil, errNoInventory
	}
	return s.Inventory(ctx)
}

// ProfileMemory is the profile's MEMORY.md / USER.md as the upstream store
// reads them: entries, characters used, caps and the two config flags. It is
// the only view of that memory openedbot has; the files never cross.
type ProfileMemory struct {
	Profile            string              `json:"profile"`
	MemoryEnabled      bool                `json:"memoryEnabled"`
	UserProfileEnabled bool                `json:"userProfileEnabled"`
	Limits             map[string]int      `json:"limits"`
	Entries            map[string][]string `json:"entries"`
	UsedChars          map[string]int      `json:"usedChars"`
	Message            string              `json:"message,omitempty"`
}

type profileMemoryWriteBody struct {
	Target  string `json:"target"`
	Action  string `json:"action"`
	Content string `json:"content"`
	OldText string `json:"oldText"`
}

var memoryTargets = map[string]bool{"memory": true, "user": true}
var memoryActions = map[string]bool{"add": true, "replace": true, "remove": true}

// MaxMemoryEntry bounds one entry or one match fragment on the wire; the
// store's own caps (2 200 / 1 375 by default) are enforced by the program.
const MaxMemoryEntry = 2000

func (s *Server) profileMemory(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	var memory ProfileMemory
	if err := s.runProbe(r.Context(), "profile-memory-get", map[string]any{"name": profile}, &memory); err != nil {
		s.writeProbeFailure(w, "profile-memory-get", err)
		return
	}
	writeJSON(w, http.StatusOK, memory)
}

func (s *Server) writeProfileMemory(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	var body profileMemoryWriteBody
	if !readBody(w, r, &body) {
		return
	}
	if !memoryTargets[body.Target] || !memoryActions[body.Action] {
		writeError(w, http.StatusBadRequest, "MEMORY_INVALID", "target must be memory or user; action must be add, replace or remove")
		return
	}
	if len(body.Content) > MaxMemoryEntry || len(body.OldText) > MaxMemoryEntry {
		writeError(w, http.StatusBadRequest, "MEMORY_INVALID", "an entry is at most 2000 characters")
		return
	}
	if !s.mcpBusy.TryLock() {
		writeError(w, http.StatusConflict, "MEMORY_IN_PROGRESS", "a memory change is already running; retry once it completes")
		return
	}
	defer s.mcpBusy.Unlock()
	request := map[string]any{"name": profile, "target": body.Target, "action": body.Action,
		"content": body.Content, "oldText": body.OldText}
	var memory ProfileMemory
	if err := s.runProbe(r.Context(), "profile-memory-write", request, &memory); err != nil {
		s.writeProbeFailure(w, "profile-memory-write", err)
		return
	}
	writeJSON(w, http.StatusOK, memory)
}

type profileMCPSetBody struct {
	Enabled *bool `json:"enabled"`
}

func (s *Server) setProfileMCP(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	server := r.PathValue("server")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	if !mcpNameRe.MatchString(server) {
		writeError(w, http.StatusBadRequest, "NAME_INVALID", "the server name is invalid")
		return
	}
	var body profileMCPSetBody
	if !readBody(w, r, &body) {
		return
	}
	if body.Enabled == nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the body must be {\"enabled\": true|false}")
		return
	}
	if !s.mcpBusy.TryLock() {
		writeError(w, http.StatusConflict, "MCP_IN_PROGRESS", "an MCP change is already running; retry once it completes")
		return
	}
	defer s.mcpBusy.Unlock()

	request := map[string]any{"name": profile, "server": server, "enabled": *body.Enabled}
	if err := s.runProbe(r.Context(), "profile-mcp-set", request, nil); err != nil {
		s.writeProbeFailure(w, "profile-mcp-set", err)
		return
	}
	s.markMCPRestartPending()
	enabled, err := s.profileMCPEnabled(r.Context(), profile, server)
	if err != nil {
		writeError(w, http.StatusBadGateway, "MCP_UNVERIFIED", "the MCP change was written but the profile inventory could not be read back")
		return
	}
	writeJSON(w, http.StatusOK, ToolsetState{
		Name: server, Profile: profile, Platform: toolsetPlatform,
		Enabled: enabled, Requested: *body.Enabled, Applied: enabled == *body.Enabled,
	})
}

// ProfileMCPRemoval is the wire shape of DELETE /profiles/{slug}/mcp/servers/{server}.
type ProfileMCPRemoval struct {
	Profile string `json:"profile"`
	Name    string `json:"name"`
	// Removed is false when the profile did not carry the server: the call is
	// idempotent, and still deletes any OAuth state left in the profile home.
	Removed bool `json:"removed"`
	// TokensRemoved is false when a token file survived the removal: the
	// server is gone from the profile, but a credential is still on disk.
	TokensRemoved bool `json:"tokensRemoved"`
}

// removeProfileMCP disconnects one MCP server from a named profile: the
// profile's config entry, its api_server platform entry, and the OAuth state
// in the profile's home. The root entry stays, other bots connect from it.
func (s *Server) removeProfileMCP(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	server := r.PathValue("server")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	if !mcpNameRe.MatchString(server) {
		writeError(w, http.StatusBadRequest, "NAME_INVALID", "the server name is invalid")
		return
	}
	if !s.mcpBusy.TryLock() {
		writeError(w, http.StatusConflict, "MCP_IN_PROGRESS", "an MCP change is already running; retry once it completes")
		return
	}
	defer s.mcpBusy.Unlock()

	var removal ProfileMCPRemoval
	request := map[string]any{"name": profile, "server": server}
	if err := s.runProbe(r.Context(), "profile-mcp-remove", request, &removal); err != nil {
		s.writeProbeFailure(w, "profile-mcp-remove", err)
		return
	}
	s.markMCPRestartPending()
	writeJSON(w, http.StatusOK, removal)
}

type profileSkillToggleBody struct {
	Enabled *bool `json:"enabled"`
}

type profileBundledSkillsState struct {
	Profile        string `json:"profile"`
	Enabled        bool   `json:"enabled"`
	Bundled        int    `json:"bundled"`
	BundledEnabled int    `json:"bundledEnabled"`
	Essential      int    `json:"essential"`
}

func (s *Server) setProfileSkill(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	skill := r.PathValue("skill")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	if !skillRe.MatchString(skill) {
		writeError(w, http.StatusBadRequest, "SKILL_INVALID", "the skill name is invalid")
		return
	}
	var body profileSkillToggleBody
	if !readBody(w, r, &body) {
		return
	}
	if body.Enabled == nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the body must be {\"enabled\": true|false}")
		return
	}
	if !s.mcpBusy.TryLock() {
		writeError(w, http.StatusConflict, "SKILL_IN_PROGRESS", "a skill change is already running; retry once it completes")
		return
	}
	defer s.mcpBusy.Unlock()

	request := map[string]any{"name": profile, "skill": skill, "enabled": *body.Enabled}
	if err := s.runProbe(r.Context(), "profile-skill-set", request, nil); err != nil {
		s.writeProbeFailure(w, "profile-skill-set", err)
		return
	}
	enabled, err := s.profileSkillEnabled(r.Context(), profile, skill)
	if err != nil {
		writeError(w, http.StatusBadGateway, "SKILL_UNVERIFIED", "the skill change was written but the profile inventory could not be read back")
		return
	}
	writeJSON(w, http.StatusOK, ToolsetState{
		Name: skill, Profile: profile, Platform: toolsetPlatform,
		Enabled: enabled, Requested: *body.Enabled, Applied: enabled == *body.Enabled,
	})
}

func (s *Server) setProfileBundledSkills(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	var body profileSkillToggleBody
	if !readStrictBody(w, r, &body) {
		return
	}
	if body.Enabled == nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the body must be {\"enabled\": true|false}")
		return
	}
	if !s.mcpBusy.TryLock() {
		writeError(w, http.StatusConflict, "SKILL_IN_PROGRESS", "a skill change is already running; retry once it completes")
		return
	}
	defer s.mcpBusy.Unlock()

	var state profileBundledSkillsState
	request := map[string]any{"name": profile, "enabled": *body.Enabled}
	if err := s.runProbe(r.Context(), "profile-bundled-skills-set", request, &state); err != nil {
		s.writeProbeFailure(w, "profile-bundled-skills-set", err)
		return
	}
	if state.Profile != profile || state.Enabled != *body.Enabled || state.Bundled < 0 || state.BundledEnabled < 0 || state.Essential < 0 || state.Essential > state.Bundled || state.BundledEnabled > state.Bundled {
		writeError(w, http.StatusBadGateway, "SKILL_UNVERIFIED", "the bundled skill change could not be verified")
		return
	}
	applied := state.BundledEnabled == state.Bundled
	if !*body.Enabled {
		applied = state.BundledEnabled == state.Essential
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"profile": profile, "requested": *body.Enabled, "bundled": state.Bundled,
		"bundledEnabled": state.BundledEnabled, "applied": applied,
	})
}

func readStrictBody(w http.ResponseWriter, r *http.Request, into any) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(raw) > MaxBody {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is missing or too large")
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is not valid for this route")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body must contain one JSON object")
		return false
	}
	return true
}

func (s *Server) profileSkillEnabled(ctx context.Context, profile, skill string) (bool, error) {
	doc, err := s.profileDocument(ctx)
	if err != nil {
		return false, err
	}
	row, ok := profileByName(doc.Profiles, profile)
	if !ok {
		return false, &probeError{Code: "PROFILE_NOT_FOUND", Message: "no profile named " + profile + " exists"}
	}
	for _, item := range row.Skills {
		if item.Name == skill {
			return item.Enabled, nil
		}
	}
	return false, &probeError{Code: "SKILL_NOT_FOUND", Message: "no skill named " + skill + " is installed on the profile"}
}

func (s *Server) profileMCPEnabled(ctx context.Context, profile, server string) (bool, error) {
	doc, err := s.profileDocument(ctx)
	if err != nil {
		return false, err
	}
	row, ok := profileByName(doc.Profiles, profile)
	if !ok {
		return false, &probeError{Code: "PROFILE_NOT_FOUND", Message: "no profile named " + profile + " exists"}
	}
	for _, item := range row.MCPServers {
		if item.Name == server {
			return item.Enabled, nil
		}
	}
	return false, &probeError{Code: "MCP_SERVER_NOT_FOUND", Message: "no MCP server named " + server + " is configured for the profile"}
}
