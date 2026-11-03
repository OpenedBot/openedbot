package operator

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

const maxAvatarBytes = 256 << 10

var allowedAvatarTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif":  true,
}

// ProfileModel is the bounded model view of one named profile.
type ProfileModel struct {
	Default  *string `json:"default"`
	Provider *string `json:"provider"`
}

// ProfileUIMeta is the hermes-bots ui_meta subset. No image bytes, no path.
type ProfileUIMeta struct {
	Title     *string  `json:"title"`
	Color     *string  `json:"color"`
	Shape     *string  `json:"shape"`
	ImageKind *string  `json:"imageKind"`
	Hidden    bool     `json:"hidden"`
	Pinned    bool     `json:"pinned"`
	SectionID *string  `json:"sectionId"`
	Groups    []string `json:"groups"`
	Created   *string  `json:"created"`
}

// ProfileRoutine is one cron job of a profile, name unwrapped, prompt unwrapped.
type ProfileRoutine struct {
	Name     string  `json:"name"`
	Schedule string  `json:"schedule"`
	Prompt   string  `json:"prompt"`
	Enabled  bool    `json:"enabled"`
	Deliver  bool    `json:"deliver"`
	Model    *string `json:"model"`
}

// ProfileNamedFlag is a skill, toolset or MCP server: name and enabled only.
type ProfileNamedFlag struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
}

// HostProfile is one non-default Hermes profile. No .env, memories or sessions.
type HostProfile struct {
	Name        string             `json:"name"`
	DisplayName string             `json:"displayName"`
	Title       *string            `json:"title"`
	Description *string            `json:"description"`
	Soul        *string            `json:"soul"`
	Model       ProfileModel       `json:"model"`
	UIMeta      *ProfileUIMeta     `json:"uiMeta"`
	HasAvatar   bool               `json:"hasAvatar"`
	Routines    []ProfileRoutine   `json:"routines"`
	Skills      []ProfileNamedFlag `json:"skills"`
	Toolsets    []ProfileNamedFlag `json:"toolsets"`
	MCPServers  []ProfileNamedFlag `json:"mcpServers"`
}

// ProfileInventory is the wire shape of GET /hermes-setup/profiles.
type ProfileInventory struct {
	Multiplex bool `json:"multiplex"`
	// MCPLiveReload: the installed gateway reconciles its MCP servers with
	// the config on disk by itself (see Server.MCPLiveReload).
	MCPLiveReload bool          `json:"mcpLiveReload,omitempty"`
	Profiles      []HostProfile `json:"profiles"`
}

type profileAvatarDoc struct {
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Bytes       string `json:"bytes"`
}

func (s *Server) profiles(w http.ResponseWriter, r *http.Request) {
	doc, err := s.profileDocument(r.Context())
	if err != nil {
		s.writeProbeFailure(w, "profiles", err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) profileDocument(ctx context.Context) (ProfileInventory, error) {
	var doc ProfileInventory
	if err := s.runProbe(ctx, "profiles", nil, &doc); err != nil {
		return doc, err
	}
	if doc.Profiles == nil {
		doc.Profiles = []HostProfile{}
	}
	return doc, nil
}

type profileCreateBody struct {
	Name        string  `json:"name"`
	DisplayName *string `json:"displayName"`
	Provider    *string `json:"provider"`
	Model       *string `json:"model"`
	// BundledSkills false turns the skills shipped with Hermes off in the
	// same probe that creates the profile. true is refused: a new profile
	// already has them on.
	BundledSkills *bool `json:"bundledSkills"`
}

type profileModelBody struct {
	Provider *string `json:"provider"`
	Model    *string `json:"model"`
}

func (s *Server) createProfile(w http.ResponseWriter, r *http.Request) {
	var body profileCreateBody
	if !readBody(w, r, &body) {
		return
	}
	if !profileSlugRe.MatchString(body.Name) || body.Name == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	if body.DisplayName != nil && (strings.TrimSpace(*body.DisplayName) == "" || len(*body.DisplayName) > 120 || hasControl(*body.DisplayName)) {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "displayName is too long or contains control characters")
		return
	}
	provider, model, ok := readOptionalModelPair(w, body.Provider, body.Model)
	if !ok {
		return
	}
	if body.BundledSkills != nil && *body.BundledSkills {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "bundledSkills can only be false")
		return
	}
	getToken := s.GatewayToken
	if getToken == nil {
		getToken = hermes.Token
	}
	token, err := getToken()
	if err != nil {
		writeError(w, http.StatusBadGateway, "HOST_UNAVAILABLE", "the gateway bearer could not be read")
		return
	}
	request := map[string]any{"name": body.Name, "apiServerKey": token}
	if body.DisplayName != nil {
		request["displayName"] = *body.DisplayName
	}
	if provider != "" {
		request["provider"] = provider
		request["model"] = model
	}
	if body.BundledSkills != nil {
		request["bundledSkills"] = false
	}
	var created profileCreateResult
	if err := s.runProbe(r.Context(), "profile-create", request, &created); err != nil {
		s.writeProbeFailure(w, "profile-create", err)
		return
	}
	// The probe re-read the profile it just wrote and checked it is listed
	// under that name with the requested model (inventory_probe.py,
	// created_profile_verified): the same proof as the full inventory, without
	// cold-starting every profile's view again. Anything less than a positive,
	// matching answer takes the full read-back below.
	bundled := createdBundledSkills(created.BundledSkills, body.Name)
	if created.Verified && created.Profile.Name == body.Name && modelMatches(created.Profile.Model, provider, model) {
		answer := map[string]any{"profile": created.Profile, "readBack": readBackProfile}
		if bundled != nil {
			answer["bundledSkills"] = bundled
		}
		writeJSON(w, http.StatusCreated, answer)
		return
	}
	doc, err := s.profileDocument(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "PROFILE_UNVERIFIED", "the profile was created but could not be read back")
		return
	}
	profile, ok := profileByName(doc.Profiles, body.Name)
	if !ok {
		writeError(w, http.StatusBadGateway, "PROFILE_UNVERIFIED", "the profile was created but was not present in the inventory")
		return
	}
	answer := map[string]any{"profile": profile}
	if bundled != nil {
		answer["bundledSkills"] = bundled
	}
	writeJSON(w, http.StatusCreated, answer)
}

// createdBundledSkills is the bundled-skills answer of a creation that asked
// for them off, in the shape of POST /profiles/{slug}/bundled-skills. nil
// (absent from the answer) when the probe did not report a coherent state:
// openedbot then writes them through that route.
func createdBundledSkills(state *profileBundledSkillsState, name string) map[string]any {
	if state == nil || state.Profile != name || state.Enabled || state.Bundled < 0 || state.BundledEnabled < 0 ||
		state.Essential < 0 || state.Essential > state.Bundled || state.BundledEnabled > state.Bundled {
		return nil
	}
	return map[string]any{
		"profile": name, "requested": false, "bundled": state.Bundled,
		"bundledEnabled": state.BundledEnabled, "applied": state.BundledEnabled == state.Essential,
	}
}

// readBackProfile marks a creation answer proven by the targeted read-back of
// the created profile alone. A host that does not send it (an older
// edge-setup) is proven by the full inventory instead, on openedbot's side too.
const readBackProfile = "profile"

type profileCreateResult struct {
	Profile       HostProfile                `json:"profile"`
	Verified      bool                       `json:"verified"`
	BundledSkills *profileBundledSkillsState `json:"bundledSkills"`
}

func modelMatches(got ProfileModel, provider, model string) bool {
	if provider == "" {
		return true
	}
	return got.Provider != nil && *got.Provider == provider && got.Default != nil && *got.Default == model
}

func (s *Server) setProfileModel(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("slug")
	if !profileSlugRe.MatchString(name) || name == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	var body profileModelBody
	if !readBody(w, r, &body) {
		return
	}
	provider, model, ok := readRequiredModelPair(w, body.Provider, body.Model)
	if !ok {
		return
	}
	request := map[string]any{"name": name, "provider": provider, "model": model}
	if err := s.runProbe(r.Context(), "profile-model-set", request, nil); err != nil {
		s.writeProbeFailure(w, "profile-model-set", err)
		return
	}
	doc, err := s.profileDocument(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "PROFILE_UNVERIFIED", "the profile model was written but the inventory could not be read back")
		return
	}
	profile, found := profileByName(doc.Profiles, name)
	if !found {
		writeError(w, http.StatusBadGateway, "PROFILE_UNVERIFIED", "the profile model was written but the profile was not present in the inventory")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"profile":  name,
		"provider": profile.Model.Provider,
		"model":    profile.Model.Default,
	})
}

func readOptionalModelPair(w http.ResponseWriter, provider, model *string) (string, string, bool) {
	if provider == nil && model == nil {
		return "", "", true
	}
	if provider == nil || model == nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "provider and model must be set together")
		return "", "", false
	}
	return readRequiredModelPair(w, provider, model)
}

func readRequiredModelPair(w http.ResponseWriter, provider, model *string) (string, string, bool) {
	if provider == nil || model == nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the body must be {\"provider\": \"...\", \"model\": \"...\"}")
		return "", "", false
	}
	p := strings.TrimSpace(*provider)
	m := strings.TrimSpace(*model)
	if !modelTokenRe.MatchString(p) || !modelTokenRe.MatchString(m) {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "provider and model must be 1-120 characters of [A-Za-z0-9._:/-]")
		return "", "", false
	}
	return p, m, true
}

func (s *Server) deleteProfile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("slug")
	if !profileSlugRe.MatchString(name) || name == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	if err := s.runProbe(r.Context(), "profile-delete", map[string]string{"name": name}, nil); err != nil {
		s.writeProbeFailure(w, "profile-delete", err)
		return
	}
	doc, err := s.profileDocument(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "PROFILE_UNVERIFIED", "the profile was deleted but the inventory could not be read back")
		return
	}
	if _, ok := profileByName(doc.Profiles, name); ok {
		writeError(w, http.StatusBadGateway, "PROFILE_UNVERIFIED", "the profile was deleted but remains in the inventory")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func profileByName(profiles []HostProfile, name string) (HostProfile, bool) {
	for _, profile := range profiles {
		if profile.Name == name {
			return profile, true
		}
	}
	return HostProfile{}, false
}

func (s *Server) profileAvatar(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	if !profileSlugRe.MatchString(slug) || slug == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	var doc profileAvatarDoc
	if err := s.runProbe(r.Context(), "profile-avatar", map[string]string{"name": slug}, &doc); err != nil {
		s.writeProbeFailure(w, "profile-avatar", err)
		return
	}
	raw, err := base64.StdEncoding.DecodeString(doc.Bytes)
	if err != nil || len(raw) == 0 {
		writeError(w, http.StatusBadGateway, "HOST_UNAVAILABLE", "the host could not complete this operation")
		return
	}
	if len(raw) > maxAvatarBytes {
		writeError(w, http.StatusBadGateway, "AVATAR_TOO_LARGE", "the avatar exceeds its bound")
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(doc.ContentType))
	if i := strings.IndexByte(contentType, ';'); i >= 0 {
		contentType = strings.TrimSpace(contentType[:i])
	}
	if !allowedAvatarTypes[contentType] {
		writeError(w, http.StatusBadGateway, "HOST_UNAVAILABLE", "the host could not complete this operation")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}
