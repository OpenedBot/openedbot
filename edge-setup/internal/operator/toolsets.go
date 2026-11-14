package operator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"

	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

// ToolsetsDocument is the wire shape of GET /hermes-setup/toolsets.
//
// It carries only what the gateway cannot say. `GET /v1/toolsets` already
// publishes every toolset with its enabled and configured state; what it does
// not publish is which of them this host will actually let the api_server
// platform carry. `_save_platform_tools` silently drops a toolset restricted
// away from the platform, so a page that offered the toggle anyway would
// report a successful no-op, naming the settable set is what prevents it.
//
// `Availability` says, per toolset, whether its tools are callable on this
// host: the answer of Hermes's own registry (`is_toolset_available`, the
// `check_fn` of each tool), which `GET /v1/toolsets` does not carry. It is
// absent from a host that predates it, and a row whose `available` is null was
// not measured (the registry does not know that toolset, or this Hermes lacks
// the function). Never read a missing row as "available".
type ToolsetsDocument struct {
	Platform     string             `json:"platform"`
	Settable     []string           `json:"settable"`
	Availability []ToolsetAvailable `json:"availability,omitempty"`
}

// ToolsetAvailable is one row of ToolsetsDocument.Availability. `Reason` is a
// closed code (see toolsetUnavailableReasons), only ever set when Available is
// false; it carries no variable name, path or value.
type ToolsetAvailable struct {
	Name      string  `json:"name"`
	Available *bool   `json:"available"`
	Reason    *string `json:"reason"`
}

// MaxToolsetAvailability bounds the rows relayed, like the settable list.
const MaxToolsetAvailability = 256

var toolsetUnavailableReasons = map[string]bool{"credentials_missing": true, "check_failed": true}

// cleanAvailability keeps the document inside its contract whatever the probe
// wrote: a valid name, at most one row per name, a reason only when the
// toolset is unavailable and only from the closed set.
func cleanAvailability(rows []ToolsetAvailable, keep func(string) bool) []ToolsetAvailable {
	if len(rows) == 0 {
		return nil
	}
	out := make([]ToolsetAvailable, 0, len(rows))
	seen := map[string]bool{}
	for _, row := range rows {
		if len(out) >= MaxToolsetAvailability {
			break
		}
		if !toolsetRe.MatchString(row.Name) || seen[row.Name] || !keep(row.Name) {
			continue
		}
		seen[row.Name] = true
		if row.Available == nil || *row.Available || row.Reason == nil || !toolsetUnavailableReasons[*row.Reason] {
			row.Reason = nil
		}
		out = append(out, row)
	}
	return out
}

// ToolsetState is the wire shape of a toggle. `Enabled` is never the value
// that was asked for: it is what `GET /v1/toolsets` says afterwards, so a
// change neutralised by `agent.disabled_toolsets` reads as the refusal it is.
type ToolsetState struct {
	Name      string `json:"name"`
	Profile   string `json:"profile,omitempty"`
	Platform  string `json:"platform"`
	Enabled   bool   `json:"enabled"`
	Requested bool   `json:"requested"`
	Applied   bool   `json:"applied"`
}

type toolsetToggleBody struct {
	Enabled *bool `json:"enabled"`
}

func (s *Server) toolsets(w http.ResponseWriter, r *http.Request) {
	var doc ToolsetsDocument
	if err := s.runProbe(r.Context(), "toolsets", nil, &doc); err != nil {
		s.writeProbeFailure(w, "toolsets", err)
		return
	}
	if doc.Platform == "" {
		doc.Platform = toolsetPlatform
	}
	if doc.Settable == nil {
		doc.Settable = []string{}
	}
	guarded := s.a2aToolsetGuardAvailable(r.Context())
	doc.Availability = cleanAvailability(doc.Availability, func(name string) bool { return guarded || name != "a2a" })
	if !guarded {
		filtered := make([]string, 0, len(doc.Settable))
		for _, name := range doc.Settable {
			if name != "a2a" {
				filtered = append(filtered, name)
			}
		}
		doc.Settable = filtered
	}
	writeJSON(w, http.StatusOK, doc)
}

// setToolset runs `hermes tools enable|disable <name> --platform api_server`.
//
// The CLI verb is the upstream-supported non-interactive write; nothing else
// about it is trusted. It prints its refusals and still exits 0, so the new
// state is read back from the gateway's own inventory and that reading, not
// the CLI's word, is what the link is told.
func (s *Server) setToolset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !toolsetRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, "TOOLSET_INVALID", "the toolset name is invalid")
		return
	}
	var body toolsetToggleBody
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

	// The refusal list is enforced here and not only in openedbot: a
	// forbidden toolset enabled through the link would leave `doctor` and the
	// audit failing on a host whose owner never asked for it.
	if pins.ToolsetIsForbidden(name, false) && wanted {
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

	// One toolset write at a time: the CLI reads, mutates and rewrites the
	// whole config file, so two concurrent runs would lose one of the changes.
	if !s.toolsetBusy.TryLock() {
		writeError(w, http.StatusConflict, "TOOLSET_IN_PROGRESS", "a toolset change is already running; retry once it completes")
		return
	}
	defer s.toolsetBusy.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), ToolsetTimeout)
	defer cancel()
	verb := "disable"
	if wanted {
		verb = "enable"
	}
	// This write does not go through the probe, so it must drop the cached
	// reads itself: `platform_toolsets.api_server` is exactly what decides the
	// `platformEnabled` flag of every MCP server in the inventory.
	defer s.dropReadCache()
	cmd := s.hermesCommand("tools", verb, name, "--platform", toolsetPlatform)
	cmd.Timeout = ToolsetTimeout
	if err := s.runConfigWriter(ctx, rootConfig, cmd); err != nil {
		s.logf("tools %s %s refused by the CLI", verb, name)
		writeError(w, http.StatusBadGateway, "CLI_REFUSED", "the runtime refused the toolset change")
		return
	}

	enabled, err := s.toolsetEnabled(ctx, name)
	if err != nil {
		writeError(w, http.StatusBadGateway, "TOOLSET_UNVERIFIED",
			"the change was written but the runtime inventory could not be read back")
		return
	}
	writeJSON(w, http.StatusOK, ToolsetState{
		Name:      name,
		Platform:  toolsetPlatform,
		Enabled:   enabled,
		Requested: wanted,
		Applied:   enabled == wanted,
	})
}

func (s *Server) a2aToolsetGuardAvailable(ctx context.Context) bool {
	return s.A2APolicyReady != nil && s.A2APolicyReady(ctx)
}

// toolsetEnabled re-reads GET /v1/toolsets on the loopback gateway.
func (s *Server) toolsetEnabled(ctx context.Context, name string) (bool, error) {
	if s.Inventory == nil {
		return false, errNoInventory
	}
	body, err := s.Inventory(ctx)
	if err != nil {
		return false, err
	}
	return gateway.ToolsetEnabled(body, name)
}
