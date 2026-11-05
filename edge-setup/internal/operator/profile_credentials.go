package operator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
)

// ProfileCredentialResult is the wire shape of a per-profile API-key add or
// delete. The key itself never appears here.
type ProfileCredentialResult struct {
	Provider     string  `json:"provider"`
	Profile      string  `json:"profile"`
	Verification string  `json:"verification"`
	Detail       *string `json:"detail,omitempty"`
}

func (s *Server) addProfileCredential(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	p, ok := provider(w, r)
	if !ok {
		return
	}
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	var body credentialBody
	raw, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(raw) > MaxBody {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is missing or too large")
		return
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "request body is not JSON")
		return
	}
	key := body.APIKey
	if key == "" || len(key) > MaxAPIKey || strings.ContainsAny(key, "\r\n") || hasControl(key) {
		writeError(w, http.StatusBadRequest, "API_KEY_INVALID", "the API key must be one non-empty line without control characters")
		return
	}
	label := body.Label
	if label == "" {
		label = "openedbot-" + s.now().UTC().Format("20060102") + "-" + randomHex(2)
	}
	if !labelRe.MatchString(label) {
		writeError(w, http.StatusBadRequest, "LABEL_INVALID", "the label is invalid")
		return
	}
	if !s.credBusy.TryLock() {
		writeError(w, http.StatusConflict, "CREDENTIAL_IN_PROGRESS", "an API-key add is already running; retry once it completes")
		return
	}
	defer s.credBusy.Unlock()

	before, err := s.snapshotProfileEnv(profile)
	if err != nil {
		writeError(w, http.StatusBadGateway, "PROFILE_ENV_REFUSED", "the profile credential environment could not be read safely")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), KeyTimeout)
	defer cancel()
	wrote := false
	if s.Runner != nil {
		cmd := s.hermesCommand("-p", profile, "auth", "add", p, "--type", "api-key", "--label", label)
		cmd.Stdin = []byte(key + "\n")
		cmd.Timeout = KeyTimeout
		if _, commandErr := exec.Must(ctx, s.Runner, cmd); commandErr == nil {
			wrote = true
		} else {
			s.logf("profile credential CLI add for %s on %s refused; falling back to the inventory program", p, profile)
		}
	}
	if !wrote {
		request := map[string]any{"name": profile, "provider": p, "apiKey": key}
		if err := s.runProbe(ctx, "profile-credential-set", request, nil); err != nil {
			s.writeProbeFailure(w, "profile-credential-set", err)
			return
		}
	}

	after, err := s.snapshotProfileEnv(profile)
	if err != nil {
		writeError(w, http.StatusBadGateway, "PROFILE_ENV_REFUSED", "the profile credential environment could not be read back")
		return
	}
	if err := s.markProfileOwnEnv(profile, before, after); err != nil {
		s.logf("profile-own credential marker failed for %s on %s", p, profile)
		writeError(w, http.StatusBadGateway, "CREDENTIAL_MIRROR_FAILED", "the credential was written but could not be marked as owned by the profile")
		return
	}

	verdict, detail := s.verifyProfile(ctx, profile, p)
	writeJSON(w, http.StatusOK, ProfileCredentialResult{Provider: p, Profile: profile, Verification: verdict, Detail: optional(detail)})
}

func (s *Server) deleteProfileCredential(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	p, ok := provider(w, r)
	if !ok {
		return
	}
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, MaxBody))
	if !s.credBusy.TryLock() {
		writeError(w, http.StatusConflict, "CREDENTIAL_IN_PROGRESS", "an API-key change is already running; retry once it completes")
		return
	}
	defer s.credBusy.Unlock()

	if err := s.runProbe(r.Context(), "profile-credential-delete", map[string]string{"name": profile, "provider": p}, nil); err != nil {
		s.writeProbeFailure(w, "profile-credential-delete", err)
		return
	}
	verdict, detail := s.verifyProfile(r.Context(), profile, p)
	writeJSON(w, http.StatusOK, ProfileCredentialResult{Provider: p, Profile: profile, Verification: verdict, Detail: optional(detail)})
}

func (s *Server) verifyProfile(ctx context.Context, profile, p string) (string, string) {
	if s.ProfileCatalogue == nil {
		return "unverified", "the profile catalogue could not be read"
	}
	body, err := s.ProfileCatalogue(ctx, profile)
	if err != nil {
		return "unverified", "the profile catalogue could not be read: " + err.Error()
	}
	state, err := gateway.ProviderState(body, p)
	if err != nil {
		return "unverified", err.Error()
	}
	switch state {
	case gateway.Authenticated:
		return "confirmed", ""
	case gateway.Denied:
		return "denied", p + " still does not authenticate against the profile catalogue"
	default:
		return "denied", p + " does not appear in the profile catalogue"
	}
}
