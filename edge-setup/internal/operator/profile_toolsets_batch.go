package operator

import (
	"context"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"net/http"
	"slices"
	"sort"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

// profileToolsetsBatchFeature announces POST /profiles/{slug}/toolsets.
const profileToolsetsBatchFeature = "profile_toolsets_batch"

// maxProfileToolsetsBatch bounds one batch: well above the toolsets Hermes
// offers on api_server, far below anything that would stretch the argv.
const maxProfileToolsetsBatch = 32

type profileToolsetsBatchBody struct {
	Toolsets map[string]*bool `json:"toolsets"`
}

// ProfileToolsetsBatch is the answer of the batch write: one state per
// requested toolset, read back from the profile, in name order.
type ProfileToolsetsBatch struct {
	Profile  string         `json:"profile"`
	Platform string         `json:"platform"`
	Toolsets []ToolsetState `json:"toolsets"`
}

// setProfileToolsets writes several toolsets of one profile in one request:
// the same guards as setProfileToolset, checked for the whole batch before
// anything is written (one refused name refuses the batch), then ONE CLI
// call per direction (`tools enable a b c`, `tools disable d e`). Each CLI
// call starts Hermes, about two seconds on a small host: a capability
// baseline that wrote its toolsets one by one spent most of a new bot's
// provisioning there. Every name is read back on its own, with the same
// suppression fallback, so `applied` stays per toolset and honest.
func (s *Server) setProfileToolsets(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("slug")
	if !profileSlugRe.MatchString(profile) || profile == "default" {
		writeError(w, http.StatusBadRequest, "PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
		return
	}
	var body profileToolsetsBatchBody
	if !readStrictBody(w, r, &body) {
		return
	}
	if len(body.Toolsets) == 0 || len(body.Toolsets) > maxProfileToolsetsBatch {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the body must be {\"toolsets\": {\"<name>\": true|false}} with 1 to 32 names")
		return
	}
	names := make([]string, 0, len(body.Toolsets))
	for name, enabled := range body.Toolsets {
		if !toolsetRe.MatchString(name) {
			writeError(w, http.StatusBadRequest, "TOOLSET_INVALID", "the toolset name is invalid")
			return
		}
		if enabled == nil {
			writeError(w, http.StatusBadRequest, "BODY_INVALID", "the body must be {\"toolsets\": {\"<name>\": true|false}} with 1 to 32 names")
			return
		}
		names = append(names, name)
	}
	sort.Strings(names)
	var enable, disable []string
	for _, name := range names {
		if *body.Toolsets[name] {
			enable = append(enable, name)
		} else {
			disable = append(disable, name)
		}
	}
	for _, name := range enable {
		if pins.ToolsetIsForbidden(name, true) {
			writeError(w, http.StatusForbidden, "TOOLSET_FORBIDDEN",
				name+" runs work outside the run openedbot leases and journals; it stays off on this host")
			return
		}
	}
	if slices.Contains(enable, "a2a") && !s.a2aToolsetGuardAvailable(r.Context()) {
		writeError(w, http.StatusForbidden, "A2A_POLICY_UNAVAILABLE", "the managed A2A toolset requires the observed peer policy guard")
		return
	}

	// Step durations, logged once per batch: a new bot's provisioning waits
	// on this route, and the total alone did not say which step was slow.
	startedAt := time.Now()
	var doc ToolsetsDocument
	if err := s.runProbe(r.Context(), "toolsets", nil, &doc); err != nil {
		s.writeProbeFailure(w, "toolsets", err)
		return
	}
	for _, name := range names {
		if !slices.Contains(doc.Settable, name) {
			writeError(w, http.StatusNotFound, "TOOLSET_NOT_SETTABLE",
				"this host does not offer "+name+" on the "+toolsetPlatform+" platform")
			return
		}
	}
	if !s.toolsetBusy.TryLock() {
		writeError(w, http.StatusConflict, "TOOLSET_IN_PROGRESS", "a toolset change is already running; retry once it completes")
		return
	}
	defer s.toolsetBusy.Unlock()
	// A profile toolset write changes that profile only (inventory.go).
	defer s.dropProfileReadCache()

	// One process for both directions when the host has the program; else
	// (or if it fails) two CLI calls at most, each with the single route's
	// bound. The read-back below proves the result either way.
	settableAt := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), 3*ToolsetTimeout)
	defer cancel()
	inProcess := false
	if s.ProfileToolsets != nil {
		err := s.withConfigLock(ctx, profile, func() error { return s.ProfileToolsets(ctx, profile, enable, disable) })
		if err != nil {
			s.logf("profile toolsets %s: the in-process write failed, falling back on the CLI", profile)
		} else {
			inProcess = true
		}
	}
	for _, group := range []struct {
		verb  string
		names []string
	}{{"enable", enable}, {"disable", disable}} {
		if inProcess || len(group.names) == 0 {
			continue
		}
		args := append([]string{"-p", profile, "tools", group.verb}, group.names...)
		cmd := s.hermesCommand(append(args, "--platform", toolsetPlatform)...)
		cmd.Timeout = ToolsetTimeout
		if err := s.runConfigWriter(ctx, profile, cmd); err != nil {
			s.logf("profile toolsets %s %s refused by the CLI", profile, group.verb)
			writeError(w, http.StatusBadGateway, "CLI_REFUSED", "the runtime refused the profile toolset change")
			return
		}
	}
	// The `memory` toolset is gated a second time by the profile's memory
	// flags (see setProfileToolset): they follow the toggle, here too.
	if wanted, ok := body.Toolsets[memoryToolset]; ok {
		var memoryState profileMemoryState
		request := map[string]any{"name": profile, "enabled": *wanted}
		if err := s.runProbe(ctx, "profile-memory-set", request, &memoryState); err != nil {
			s.writeProbeFailure(w, "profile-memory-set", err)
			return
		}
	}
	writtenAt := time.Now()
	enabled, err := s.readBackProfileToolsets(ctx, profile, names, body.Toolsets)
	s.logf("profile toolsets %s: %d names, settable %dms, write %dms (one process: %t), read-back %dms",
		profile, len(names), settableAt.Sub(startedAt).Milliseconds(), writtenAt.Sub(settableAt).Milliseconds(),
		inProcess, time.Since(writtenAt).Milliseconds())
	if err != nil {
		writeError(w, http.StatusBadGateway, "TOOLSET_UNVERIFIED",
			"the change was written but the profile inventory could not be read back")
		return
	}
	states := make([]ToolsetState, 0, len(names))
	for _, name := range names {
		wanted := *body.Toolsets[name]
		states = append(states, ToolsetState{
			Name: name, Profile: profile, Platform: toolsetPlatform,
			Enabled: enabled[name], Requested: wanted, Applied: enabled[name] == wanted,
		})
	}
	writeJSON(w, http.StatusOK, ProfileToolsetsBatch{Profile: profile, Platform: toolsetPlatform, Toolsets: states})
}

// readBackProfileToolsets reads the profile's toolsets ONCE for the whole
// batch: one gateway read per name cost the batch seconds on a busy host
// (VM 240, 2026-11-02). A name the platform list did not move gets the
// single route's suppression fallback, then one more read covers them all.
func (s *Server) readBackProfileToolsets(ctx context.Context, profile string, names []string, wanted map[string]*bool) (map[string]bool, error) {
	read := func() (map[string]bool, error) {
		doc, err := s.profileToolsetDocument(ctx, profile)
		if err != nil {
			return nil, err
		}
		states := make(map[string]bool, len(names))
		for _, name := range names {
			enabled, err := gateway.ToolsetEnabled(doc, name)
			if err != nil {
				return nil, err
			}
			states[name] = enabled
		}
		return states, nil
	}
	states, err := read()
	if err != nil {
		return nil, err
	}
	suppressed := false
	for _, name := range names {
		if states[name] == *wanted[name] {
			continue
		}
		request := map[string]any{"name": profile, "toolset": name, "suppressed": !*wanted[name]}
		if probeErr := s.runProbe(ctx, "profile-toolset-suppress", request, nil); probeErr != nil {
			s.logf("profile toolset %s %s suppression refused", profile, name)
			continue
		}
		suppressed = true
	}
	if !suppressed {
		return states, nil
	}
	return read()
}
