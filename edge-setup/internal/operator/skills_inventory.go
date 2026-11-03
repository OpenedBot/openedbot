package operator

import (
	"net/http"
)

// SkillsInventoryFeature announces GET /skills: the root's installed skills,
// read by the embedded program. openedbot reads it only when the gateway's own
// /v1/skills fails, which Hermes 0.21.3 to 0.22.6 do on every call (a removed
// `include_editorial` keyword, upstream #142575).
const SkillsInventoryFeature = "skills_inventory"

// SkillsDocument is the /v1/skills shape, so openedbot parses both the same way.
type SkillsDocument struct {
	Object string        `json:"object"`
	Data   []SkillRecord `json:"data"`
}

// SkillRecord is one installed skill.
type SkillRecord struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Category    *string `json:"category"`
}

func (s *Server) skills(w http.ResponseWriter, r *http.Request) {
	var doc SkillsDocument
	if err := s.runProbe(r.Context(), "skills", nil, &doc); err != nil {
		s.writeProbeFailure(w, "skills", err)
		return
	}
	if doc.Data == nil {
		doc.Data = []SkillRecord{}
	}
	doc.Object = "list"
	writeJSON(w, http.StatusOK, doc)
}
