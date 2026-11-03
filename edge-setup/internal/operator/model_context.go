package operator

import (
	"net/http"
)

// MaxContextWindow bounds every token count this route publishes. No model
// family comes close, and a runaway upstream value must not reach a progress
// bar as a denominator that makes every reading read as zero percent.
const MaxContextWindow = 16_000_000

// ModelContextDocument is the wire shape of GET /hermes-setup/model-context.
//
// It carries what the gateway cannot say. `GET /v1/models` publishes an
// identifier and nothing else, `GET /api/model/options` publishes the picker
// inventory, and `GET /v1/capabilities` publishes feature flags: none of the
// three says how large the configured model's context window is. Upstream
// resolves it in `agent.model_metadata.get_model_context_length` and serves it
// on the Dashboard route `GET /api/model/info`, which the link does not carry.
//
// `Effective` is the number the agent actually applies: the configured
// override when there is one, the auto-detected value otherwise. Zero means
// unknown, never zero tokens: a caller that reads zero must fall back to its
// own table rather than draw a full bar.
type ModelContextDocument struct {
	Profile   string `json:"profile,omitempty"`
	Model     string `json:"model"`
	Provider  string `json:"provider"`
	Auto      int    `json:"autoContextLength"`
	Config    int    `json:"configContextLength"`
	Effective int    `json:"effectiveContextLength"`
	MaxOutput int    `json:"maxOutputTokens"`
	// Preamble is what the gateway puts in front of every run (identity,
	// memory, skills index, tool schemas, MCP servers), sized by the probe.
	// Absent from an older probe: the caller then knows only its own share.
	Preamble *ContextPreamble `json:"preamble,omitempty"`
}

// ContextPreamble carries sizes and names only, never content.
type ContextPreamble struct {
	Buckets []PreambleBucket `json:"buckets"`
}

// PreambleBucket is one part of the preamble. A nil Tokens means "present,
// not measured" (MCP schemas, a tool list the probe could not resolve): it
// must never be read as zero.
type PreambleBucket struct {
	Key    string         `json:"key"`
	Tokens *int           `json:"tokens"`
	Items  []PreambleItem `json:"items"`
}

// PreambleItem is one named member of a bucket: a tool, a skill, a file, a server.
type PreambleItem struct {
	Name   string `json:"name"`
	Tokens *int   `json:"tokens"`
}

// preambleKeys is the closed set of buckets the route publishes, in order.
var preambleKeys = []string{"identity", "memory", "skills", "tools", "mcp"}

const (
	maxPreambleItems = 64
	maxPreambleName  = 64
)

type modelContextRequest struct {
	Profile string `json:"profile,omitempty"`
}

// modelContext serves the configured model's context window, read-only.
//
// The probe resolves it exactly as upstream's Dashboard does, and returns
// three integers plus the model and provider names. The `base_url` used to
// resolve it names a private host and never leaves the probe.
func (s *Server) modelContext(w http.ResponseWriter, r *http.Request) {
	profile := r.URL.Query().Get("profile")
	if profile != "" && !profileSlugRe.MatchString(profile) {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name is invalid")
		return
	}
	var doc ModelContextDocument
	if err := s.runProbe(r.Context(), "model-context", modelContextRequest{Profile: profile}, &doc); err != nil {
		s.writeProbeFailure(w, "model-context", err)
		return
	}
	doc.Auto = boundContextWindow(doc.Auto)
	doc.Config = boundContextWindow(doc.Config)
	doc.Effective = boundContextWindow(doc.Effective)
	doc.MaxOutput = boundContextWindow(doc.MaxOutput)
	// The probe already applies this precedence; re-applying it here means a
	// host running an older probe cannot publish a config override that the
	// effective reading contradicts.
	if doc.Config > 0 {
		doc.Effective = doc.Config
	} else if doc.Effective == 0 {
		doc.Effective = doc.Auto
	}
	doc.Preamble = boundPreamble(doc.Preamble)
	writeJSON(w, http.StatusOK, doc)
}

func boundContextWindow(value int) int {
	if value <= 0 || value > MaxContextWindow {
		return 0
	}
	return value
}

// boundTokens keeps nil as nil (not measured) and turns an implausible count
// into nil too: a bar must not draw a part the host could not size.
func boundTokens(value *int) *int {
	if value == nil || *value < 0 || *value > MaxContextWindow {
		return nil
	}
	out := *value
	return &out
}

// boundPreamble re-checks what the probe printed: known keys only, each once,
// in a fixed order, with bounded names and counts. Whatever a probe of another
// version prints, the wire shape stays this one.
func boundPreamble(in *ContextPreamble) *ContextPreamble {
	if in == nil {
		return nil
	}
	byKey := make(map[string]PreambleBucket, len(in.Buckets))
	for _, bucket := range in.Buckets {
		if _, seen := byKey[bucket.Key]; !seen {
			byKey[bucket.Key] = bucket
		}
	}
	out := &ContextPreamble{Buckets: []PreambleBucket{}}
	for _, key := range preambleKeys {
		bucket, ok := byKey[key]
		if !ok {
			continue
		}
		items := []PreambleItem{}
		for _, item := range bucket.Items {
			if len(items) >= maxPreambleItems {
				break
			}
			name := boundName(item.Name)
			if name == "" {
				continue
			}
			items = append(items, PreambleItem{Name: name, Tokens: boundTokens(item.Tokens)})
		}
		out.Buckets = append(out.Buckets, PreambleBucket{Key: key, Tokens: boundTokens(bucket.Tokens), Items: items})
	}
	return out
}

// boundName keeps a printable name of at most maxPreambleName runes.
func boundName(raw string) string {
	runes := []rune{}
	for _, r := range raw {
		if r < 0x20 || r == 0x7f {
			continue
		}
		runes = append(runes, r)
		if len(runes) >= maxPreambleName {
			break
		}
	}
	return string(runes)
}
