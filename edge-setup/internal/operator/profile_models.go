package operator

import (
	"net/http"
)

// MaxProfileModelBatch bounds POST /profiles/models. 64 slugs of 63 characters
// still fit MaxBody with their JSON quoting.
const MaxProfileModelBatch = 64

type profileModelsBody struct {
	Provider *string  `json:"provider"`
	Model    *string  `json:"model"`
	Profiles []string `json:"profiles"`
}

// profileModelResult is the read-back of one profile after a batch write.
// Applied is true only when the inventory read after the write shows the
// requested pair: an exit code proves nothing.
type profileModelResult struct {
	Profile  string  `json:"profile"`
	Provider *string `json:"provider"`
	Model    *string `json:"model"`
	Applied  bool    `json:"applied"`
	Code     string  `json:"code,omitempty"`
}

type profileModelsProbeReply struct {
	Profiles []struct {
		Profile string `json:"profile"`
		Code    string `json:"code"`
	} `json:"profiles"`
}

// setProfileModels writes one provider/model pair into the model block of
// several named profiles: one probe for every write, one inventory read for
// every proof. The per-profile route pays both for each profile, which made a
// fleet-wide change take seconds per bot. A profile the probe refuses (absent,
// unreadable config) is reported with its code; the others still apply.
func (s *Server) setProfileModels(w http.ResponseWriter, r *http.Request) {
	var body profileModelsBody
	if !readBody(w, r, &body) {
		return
	}
	provider, model, ok := readRequiredModelPair(w, body.Provider, body.Model)
	if !ok {
		return
	}
	if len(body.Profiles) == 0 || len(body.Profiles) > MaxProfileModelBatch {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "profiles must list 1 to 64 profile names")
		return
	}
	seen := map[string]bool{}
	names := make([]string, 0, len(body.Profiles))
	for _, name := range body.Profiles {
		if !profileSlugRe.MatchString(name) || name == "default" {
			writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "each profile name must be 1-63 characters of [a-z0-9_-], and not default")
			return
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	var reply profileModelsProbeReply
	request := map[string]any{"names": names, "provider": provider, "model": model}
	if err := s.runProbe(r.Context(), "profile-models-set", request, &reply); err != nil {
		s.writeProbeFailure(w, "profile-models-set", err)
		return
	}
	refused := map[string]string{}
	for _, entry := range reply.Profiles {
		if entry.Code != "" {
			refused[entry.Profile] = entry.Code
		}
	}
	doc, err := s.profileDocument(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "PROFILE_UNVERIFIED", "the profile models were written but the inventory could not be read back")
		return
	}
	results := make([]profileModelResult, 0, len(names))
	for _, name := range names {
		result := profileModelResult{Profile: name, Code: refused[name]}
		if profile, found := profileByName(doc.Profiles, name); found {
			result.Provider, result.Model = profile.Model.Provider, profile.Model.Default
			result.Applied = result.Code == "" &&
				profile.Model.Provider != nil && *profile.Model.Provider == provider &&
				profile.Model.Default != nil && *profile.Model.Default == model
		} else if result.Code == "" {
			result.Code = "PROFILE_NOT_FOUND"
		}
		results = append(results, result)
	}
	writeJSON(w, http.StatusOK, map[string]any{"provider": provider, "model": model, "profiles": results})
}
