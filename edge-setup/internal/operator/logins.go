package operator

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
)

const pruneLoginsTimeout = 20 * time.Second

var (
	poolHeaderRe = regexp.MustCompile(`^(\S+) \(\d+ credentials?\):`)
	poolEntryRe  = regexp.MustCompile(`^\s+#\d+\s+(\S+)\s`)
)

// poolLabels reads the `hermes auth list` output and returns, in pool order,
// the labels of provider's pooled credentials. The newest is last: the CLI
// appends.
func poolLabels(listing, provider string) []string {
	var labels []string
	current := ""
	for _, line := range strings.Split(listing, "\n") {
		if m := poolHeaderRe.FindStringSubmatch(line); m != nil {
			current = m[1]
			continue
		}
		if current != provider {
			continue
		}
		if m := poolEntryRe.FindStringSubmatch(line); m != nil && labelRe.MatchString(m[1]) {
			labels = append(labels, m[1])
		}
	}
	return labels
}

// pruneStaleLogins removes every pooled credential of provider but the newest,
// once a login openedbot started has completed. openedbot connects ONE account per
// provider: `hermes auth add` appends to the pool, so a re-authentication left
// the previous logins in place. Measured 2026-09-05: two exhausted logins of a
// replaced account stayed ahead of the fresh one, the gateway retried them
// every hour (a 429 per rotation) and the usage probe kept reporting the old
// account at 100 %. Returns the labels removed; a listing or removal that
// fails leaves the pool as it is, the login itself is already confirmed.
func (s *Server) pruneStaleLogins(ctx context.Context, provider string) []string {
	listing, err := s.Runner.Run(ctx, s.hermesCommand("auth", "list"))
	if err != nil || listing.ExitCode != 0 {
		return nil
	}
	labels := poolLabels(listing.Stdout, provider)
	if len(labels) < 2 {
		return nil
	}
	var removed []string
	for _, label := range labels[:len(labels)-1] {
		res, err := s.Runner.Run(ctx, s.hermesCommand("auth", "remove", provider, label))
		if err != nil || res.ExitCode != 0 {
			s.logf("stale login %s of %s could not be removed", label, provider)
			continue
		}
		removed = append(removed, label)
	}
	return removed
}

const adoptRootGrantTimeout = 30 * time.Second

// singleUseOAuthProviders mirrors upstream SINGLE_USE_REFRESH_POOL_PROVIDERS
// (hermes_cli/auth_oauth_grants.py): their refresh token is redeemed once,
// so a profile can only share the root login, never hold a copy of it.
var singleUseOAuthProviders = map[string]bool{
	"anthropic":    true,
	"openai-codex": true,
	"xai-oauth":    true,
	"nous":         true,
}

// profileGrantAdoption is the probe's proof, sorted per named profile:
// Profiles dropped their own login of the provider and now read the root one;
// OwnAPIKey keep their own API key for it (upstream gives a profile its own
// pool slice whenever it is non-empty), so they do not read the root login and
// are never counted as adopted; Independent hold a login that may be another
// live account (neither spent nor provably root's account or lineage), left
// untouched and never counted as adopted; Refused could not be read, or still
// hold an OAuth grant after the write. Profile names only, never a token.
type profileGrantAdoption struct {
	Provider    string                `json:"provider"`
	Profiles    []string              `json:"profiles"`
	OwnAPIKey   []string              `json:"ownApiKey"`
	Independent []string              `json:"independent"`
	Refused     []profileGrantRefusal `json:"refused"`
}

type profileGrantRefusal struct {
	Profile string `json:"profile"`
	Code    string `json:"code"`
}

// adoptRootOAuthGrant runs once a login openedbot started has landed in the ROOT
// store. Upstream gives a named profile the root grant only while that profile
// has no login of its own for the provider, so a profile that once logged in
// by itself (`hermes -p <slug> model`, an imported store) kept a revoked
// refresh token: its bot kept failing with `invalid_grant` after every
// reconnection from the console. The probe drops that provider's OAuth state
// from the named profiles whose grants are all spent or provably root's
// account or lineage (API keys untouched), and re-reads each store.
//
// Without a probe there are no named profiles to reach and nothing to do. The
// returned error is the session's message: the login is in the root store,
// but a bot may still run on a dead one, which must not read as "connected".
// A profile that keeps its own API key is a deliberate per-bot key, not a
// failure of this login: it is logged, not adopted. So is a profile that keeps
// a live login of another account: a global reconnection never drops it.
func (s *Server) adoptRootOAuthGrant(provider string) error {
	if !singleUseOAuthProviders[provider] || s.Probe == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), adoptRootGrantTimeout)
	defer cancel()
	var adoption profileGrantAdoption
	if err := s.runProbe(ctx, "profile-oauth-adopt-root", map[string]string{"provider": provider}, &adoption); err != nil {
		s.logf("named profiles could not be checked for the new %s login", provider)
		return errors.New("the login was saved, but the named profiles could not be checked for an older login of " + provider)
	}
	if len(adoption.Profiles) > 0 {
		s.logf("%d named profile(s) now read the new %s login", len(adoption.Profiles), provider)
	}
	if len(adoption.OwnAPIKey) > 0 {
		s.logf("%d named profile(s) keep their own %s API key", len(adoption.OwnAPIKey), provider)
	}
	if len(adoption.Independent) > 0 {
		s.logf("%d named profile(s) keep their own %s login of another account", len(adoption.Independent), provider)
	}
	return adoptionRefusal(provider, adoption.Refused)
}

// adoptionRefusal names the refused profiles, one message per cause: an
// unreadable store is not an older login, and the operator fixes them apart.
func adoptionRefusal(provider string, refused []profileGrantRefusal) error {
	var unreadable, kept []string
	for _, r := range refused {
		if r.Code == "PROFILE_AUTH_UNREADABLE" {
			unreadable = append(unreadable, r.Profile)
		} else {
			kept = append(kept, r.Profile)
		}
	}
	var parts []string
	if len(kept) > 0 {
		parts = append(parts, "the named profile(s) "+strings.Join(kept, ", ")+" still use their own older login of "+provider)
	}
	if len(unreadable) > 0 {
		parts = append(parts, "the credential store of the named profile(s) "+strings.Join(unreadable, ", ")+" could not be read")
	}
	if len(parts) == 0 {
		return nil
	}
	return errors.New("the login was saved, but " + strings.Join(parts, "; "))
}
