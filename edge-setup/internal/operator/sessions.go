package operator

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
)

// MaxSessionsInventory bounds GET /hermes-setup/sessions-inventory. Beyond
// it the document says `truncated`; it never grows past this many rows.
const MaxSessionsInventory = 500

// HostSession is one Hermes session as the reconciliation needs it: an
// identifier, the profile that owns it and when it started. No title, no
// model, no message, no path: the content of a session never crosses here.
type HostSession struct {
	ID        string `json:"id"`
	Profile   string `json:"profile"`
	CreatedAt string `json:"createdAt"`
}

// SessionsInventory is the wire shape of GET /hermes-setup/sessions-inventory.
type SessionsInventory struct {
	Sessions  []HostSession `json:"sessions"`
	Total     int           `json:"total"`
	Truncated bool          `json:"truncated"`
}

// sessionsInventory lists every session of the default profile and of each
// named profile, paging the Dashboard route until its `total` is reached or
// the inventory bound is hit. openedbot compares this list with the runs
// it dispatched itself: a session it never created is a creation outside
// the link.
func (s *Server) sessionsInventory(w http.ResponseWriter, r *http.Request) {
	if s.Sessions == nil {
		writeError(w, http.StatusNotFound, "ROUTE_UNKNOWN", "the session inventory is not served by this operator")
		return
	}
	profiles := []string{""}
	if s.Probe != nil {
		doc, err := s.profileDocument(r.Context())
		if err != nil {
			s.writeProbeFailure(w, "profiles", err)
			return
		}
		for _, p := range doc.Profiles {
			if profileSlugRe.MatchString(p.Name) {
				profiles = append(profiles, p.Name)
			}
		}
	}
	inventory := SessionsInventory{Sessions: []HostSession{}}
	for _, profile := range profiles {
		if err := s.collectSessions(r.Context(), profile, &inventory); err != nil {
			s.logf("session inventory of profile %q failed on the host", profile)
			writeError(w, http.StatusBadGateway, "HOST_UNAVAILABLE", "the host could not list its sessions")
			return
		}
		if inventory.Truncated {
			break
		}
	}
	writeJSON(w, http.StatusOK, inventory)
}

// sessionsPage is the upstream `GET /api/sessions` document, bounded to
// what the inventory keeps. `started_at` is epoch seconds upstream.
type sessionsPage struct {
	Sessions []struct {
		ID        string  `json:"id"`
		StartedAt float64 `json:"started_at"`
	} `json:"sessions"`
	Total int `json:"total"`
}

func (s *Server) collectSessions(ctx context.Context, profile string, inventory *SessionsInventory) error {
	label := profile
	if label == "" {
		label = "default"
	}
	offset := 0
	for {
		raw, err := s.Sessions(ctx, profile, offset)
		if err != nil {
			return err
		}
		if len(raw) > gateway.MaxBody {
			return errors.New("session page too large")
		}
		var page sessionsPage
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		inventory.Total += len(page.Sessions)
		for _, row := range page.Sessions {
			if !sessionRe.MatchString(row.ID) {
				continue
			}
			if len(inventory.Sessions) >= MaxSessionsInventory {
				inventory.Truncated = true
				return nil
			}
			inventory.Sessions = append(inventory.Sessions, HostSession{ID: row.ID, Profile: label, CreatedAt: epochRFC3339(row.StartedAt)})
		}
		offset += len(page.Sessions)
		if len(page.Sessions) == 0 || offset >= page.Total {
			return nil
		}
	}
}

func epochRFC3339(seconds float64) string {
	if seconds <= 0 {
		return ""
	}
	return time.Unix(int64(seconds), 0).UTC().Format(time.RFC3339)
}
