// Package gateway is the loopback client to the Hermes api_server used by
// install, doctor, canary and credentials proofs. The bearer is read from
// runtime.env on the host and never leaves this process.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

// Client talks to one gateway base URL.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// Loopback returns a client for the local gateway.
func Loopback(token string) Client {
	return Client{BaseURL: "http://127.0.0.1:8642", Token: token, HTTP: &http.Client{Timeout: 20 * time.Second}}
}

// MaxBody bounds every response read.
const MaxBody = 1 << 20

func (c Client) do(ctx context.Context, path string, auth bool) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return 0, nil, err
	}
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxBody))
	return resp.StatusCode, body, err
}

// Health returns the /health status code (200, 401 and 403 all mean the
// gateway is up).
func (c Client) Health(ctx context.Context) (int, error) {
	status, _, err := c.do(ctx, "/health", false)
	return status, err
}

// WaitHealthy polls /health until it answers 200/401/403 or the deadline.
func (c Client) WaitHealthy(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		status, err := c.Health(ctx)
		if err == nil && (status == 200 || status == 401 || status == 403) {
			return nil
		}
		if err != nil {
			last = err
		} else {
			last = fmt.Errorf("/health returned HTTP %d", status)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return fmt.Errorf("gateway did not become healthy: %v", last)
}

// RequireUnauthorizedWithoutBearer proves the gateway refuses anonymous
// calls to an authenticated route.
func (c Client) RequireUnauthorizedWithoutBearer(ctx context.Context) error {
	status, _, err := Client{BaseURL: c.BaseURL, HTTP: c.HTTP}.do(ctx, "/v1/toolsets", false)
	if err != nil {
		return err
	}
	if status != 401 && status != 403 {
		return fmt.Errorf("anonymous /v1/toolsets returned HTTP %d instead of 401/403", status)
	}
	return nil
}

// SessionsPage is the upstream page bound of GET /api/sessions (`le=100`).
const SessionsPage = 100

// Sessions reads one page of the Dashboard session list, archived sessions
// included, for the default profile (empty) or a named one. The caller
// validates the slug; the rows are bounded and parsed by the operator.
func (c Client) Sessions(ctx context.Context, profile string, offset int) ([]byte, error) {
	query := url.Values{}
	query.Set("limit", strconv.Itoa(SessionsPage))
	query.Set("offset", strconv.Itoa(offset))
	query.Set("archived", "include")
	query.Set("order", "created")
	if profile != "" {
		query.Set("profile", profile)
	}
	status, body, err := c.do(ctx, "/api/sessions?"+query.Encode(), true)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("/api/sessions returned HTTP %d", status)
	}
	return body, nil
}

// Toolsets fetches the enabled toolset names.
func (c Client) Toolsets(ctx context.Context) ([]string, error) {
	body, err := c.ToolsetInventory(ctx)
	if err != nil {
		return nil, err
	}
	return EnabledToolsets(body)
}

// ToolsetInventory returns the raw /v1/toolsets body, for callers that need
// the per-toolset state and not only the enabled names.
func (c Client) ToolsetInventory(ctx context.Context) ([]byte, error) {
	status, body, err := c.do(ctx, "/v1/toolsets", true)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("/v1/toolsets returned HTTP %d", status)
	}
	return body, nil
}

// ProfileToolsetInventory reads the api_server toolsets of one named profile.
// The caller validates the profile slug before constructing this path; the
// gateway route is nevertheless kept separate so a named profile can never
// accidentally be proven against the root inventory.
func (c Client) ProfileToolsetInventory(ctx context.Context, profile string) ([]byte, error) {
	status, body, err := c.do(ctx, "/p/"+profile+"/v1/toolsets", true)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("profile /v1/toolsets returned HTTP %d", status)
	}
	return body, nil
}

// EnabledToolsets parses a /v1/toolsets payload into sorted enabled names.
func EnabledToolsets(body []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			Name    string `json:"name"`
			Enabled bool   `json:"enabled"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("toolset inventory is not JSON: %w", err)
	}
	if payload.Data == nil {
		return nil, errors.New("toolset inventory is not a data array")
	}
	var names []string
	for _, e := range payload.Data {
		if e.Enabled {
			names = append(names, strings.ToLower(strings.TrimSpace(e.Name)))
		}
	}
	sort.Strings(names)
	return names, nil
}

// ToolsetEnabled reports whether one named toolset is enabled in a
// /v1/toolsets payload. Unlike EnabledToolsets it answers about a toolset the
// inventory may legitimately list as disabled, so an absent name is `false`
// and not an error, only an unreadable inventory is.
func ToolsetEnabled(body []byte, name string) (bool, error) {
	enabled, err := EnabledToolsets(body)
	if err != nil {
		return false, err
	}
	want := strings.ToLower(strings.TrimSpace(name))
	for _, candidate := range enabled {
		if candidate == want {
			return true, nil
		}
	}
	return false, nil
}

// RequireToolsetPolicy fails when a forbidden toolset is enabled.
//
// It replaces an exact-equality check against pins.APIToolsets. That check was
// right while the catalogue was frozen at install time; it is wrong now that
// the owner turns a toolset on or off from the console or through the link,
// where every legitimate change would have read as a failed audit. What is
// actually invariant is the refusal list, and that is what is checked.
func RequireToolsetPolicy(enabled []string) error {
	present := map[string]bool{}
	for _, name := range enabled {
		present[name] = true
	}
	var active []string
	for _, name := range pins.ForbiddenToolsets {
		if present[name] {
			active = append(active, name)
		}
	}
	if len(active) > 0 {
		sort.Strings(active)
		return fmt.Errorf("forbidden toolsets are enabled: %s", strings.Join(active, ", "))
	}
	return nil
}

// ProviderVerdict is the authentication state of a provider.
type ProviderVerdict string

// Verdicts.
const (
	Authenticated ProviderVerdict = "authenticated"
	Denied        ProviderVerdict = "denied"
	Absent        ProviderVerdict = "absent"
)

// ModelOptions reads /api/model/options.
func (c Client) ModelOptions(ctx context.Context) ([]byte, error) {
	status, body, err := c.do(ctx, "/api/model/options", true)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("/api/model/options returned HTTP %d", status)
	}
	return body, nil
}

var profileSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

// ProfileModelOptions reads /p/<slug>/api/model/options. The slug is
// re-validated here so a named profile is never proven against the root
// catalogue, even if a caller skipped its own check.
func (c Client) ProfileModelOptions(ctx context.Context, profile string) ([]byte, error) {
	if !profileSlug.MatchString(profile) || profile == "default" {
		return nil, fmt.Errorf("profile catalogue slug is invalid")
	}
	status, body, err := c.do(ctx, "/p/"+profile+"/api/model/options", true)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("profile /api/model/options returned HTTP %d", status)
	}
	return body, nil
}

// ProviderState parses /api/model/options for one provider slug.
func ProviderState(body []byte, slug string) (ProviderVerdict, error) {
	var payload struct {
		Providers []struct {
			Slug          string `json:"slug"`
			Authenticated bool   `json:"authenticated"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("model catalogue is not JSON: %w", err)
	}
	for _, p := range payload.Providers {
		if p.Slug == slug {
			if p.Authenticated {
				return Authenticated, nil
			}
			return Denied, nil
		}
	}
	return Absent, nil
}

var tokenRe = regexp.MustCompile(`^[A-Fa-f0-9]{32,128}$`)

// ValidToken reports whether a bearer satisfies the hexadecimal contract.
func ValidToken(t string) bool { return tokenRe.MatchString(t) }
