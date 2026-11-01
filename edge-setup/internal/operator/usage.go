package operator

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const (
	usageCacheTTL     = time.Minute
	usageProbeTimeout = 25 * time.Second
	maxUsageOutput    = 256 << 10
	maxUsageProviders = 32
	maxUsageWindows   = 8
	maxUsageDetails   = 16
)

var usageProbeProviders = []string{"anthropic", "openai-codex", "openrouter"}

//go:embed usage_probe.py
var usageProbeScript []byte

// UsageProbe executes the embedded interpreter program. It is injectable to
// prove the HTTP contract without a runtime account or an external API call.
type UsageProbe func(context.Context, []string) ([]byte, error)

// UsageDocument is the bounded public result of GET /hermes-setup/usage.
type UsageDocument struct {
	FetchedAt string          `json:"fetchedAt"`
	Providers []ProviderUsage `json:"providers"`
}

// ProviderUsage describes one provider account. Source is intentionally a
// small closed set, so callers never need to interpret upstream diagnostics.
type ProviderUsage struct {
	Provider          string        `json:"provider"`
	Source            string        `json:"source"`
	Plan              *string       `json:"plan"`
	Windows           []UsageWindow `json:"windows"`
	Details           []string      `json:"details"`
	UnavailableReason *string       `json:"unavailableReason"`
}

// UsageWindow is a quota window returned by an upstream account API.
type UsageWindow struct {
	Label       string   `json:"label"`
	UsedPercent *float64 `json:"usedPercent"`
	ResetAt     *string  `json:"resetAt"`
	Detail      *string  `json:"detail"`
}

type usageCache struct {
	document UsageDocument
	expires  time.Time
}

type usageFlight struct {
	done     chan struct{}
	document UsageDocument
	err      error
}

// HostUsageProbe runs only the venv Python interpreter with its immutable
// embedded source on stdin. Its arguments are fixed provider slugs; there is
// no shell, path, URL, secret, or caller-provided command in argv.
func HostUsageProbe(runner exec.Runner) UsageProbe {
	return hostUsageProbeWithCommand(runner, usageProbeSpec)
}

func hostUsageProbeWithCommand(runner exec.Runner, command func([]string) exec.Cmd) UsageProbe {
	return func(ctx context.Context, providers []string) ([]byte, error) {
		cmd := command(providers)
		res, err := runner.Run(ctx, cmd)
		if err != nil {
			return nil, err
		}
		if res.ExitCode != 0 {
			return nil, errors.New("account usage probe exited unsuccessfully")
		}
		if len(res.Stdout) == 0 || len(res.Stdout) > maxUsageOutput {
			return nil, errors.New("account usage probe returned an invalid response size")
		}
		return []byte(res.Stdout), nil
	}
}

func serviceEnv() []string {
	return []string{
		"HERMES_HOME=" + layout.RuntimeRoot,
		"HOME=" + layout.RuntimeRoot + "/home",
		"PATH=" + layout.VenvBin + ":/usr/bin:/bin",
		"PYTHONUNBUFFERED=1",
		"TERM=dumb",
		"NO_COLOR=1",
	}
}

func usageProbeSpec(providers []string) exec.Cmd {
	args := []string{"-"}
	for _, provider := range usageProbeProviders {
		for _, requested := range providers {
			if requested == provider {
				args = append(args, provider)
				break
			}
		}
	}
	cmd := account.AsUser(layout.ServiceUser, serviceEnv(), layout.VenvBin+"/python", args...)
	cmd.Stdin = append([]byte(nil), usageProbeScript...)
	cmd.Timeout = usageProbeTimeout
	return cmd
}

// providerUsage serves the cached document for up to usageCacheTTL. A forced
// read (Cache-Control: no-cache, openedbot's « Actualiser ») skips that cache but
// still joins an in-flight probe: two refreshes never run two probes.
func (s *Server) providerUsage(ctx context.Context, force bool) (UsageDocument, error) {
	now := s.now()
	s.mu.Lock()
	if !force && s.usageCache != nil && now.Before(s.usageCache.expires) {
		document := s.usageCache.document
		s.mu.Unlock()
		return document, nil
	}
	if flight := s.usageFlight; flight != nil {
		s.mu.Unlock()
		select {
		case <-flight.done:
			return flight.document, flight.err
		case <-ctx.Done():
			return UsageDocument{}, ctx.Err()
		}
	}
	flight := &usageFlight{done: make(chan struct{})}
	s.usageFlight = flight
	s.mu.Unlock()

	// The shared flight must survive the first HTTP caller going away.
	probeCtx, cancel := context.WithTimeout(context.Background(), usageProbeTimeout)
	document, err := s.fetchUsage(probeCtx)
	cancel()

	s.mu.Lock()
	if err == nil {
		s.usageCache = &usageCache{document: document, expires: s.now().Add(usageCacheTTL)}
	}
	flight.document, flight.err = document, err
	s.usageFlight = nil
	close(flight.done)
	s.mu.Unlock()
	return document, err
}

func (s *Server) fetchUsage(ctx context.Context) (UsageDocument, error) {
	probed, unsupported := s.usageProviders(ctx)
	document := UsageDocument{FetchedAt: s.now().UTC().Format(time.RFC3339), Providers: unsupported}
	if len(probed) == 0 {
		return document, nil
	}
	if s.UsageProbe == nil {
		return UsageDocument{}, errors.New("account usage probe is unavailable")
	}
	raw, err := s.UsageProbe(ctx, probed)
	if err != nil {
		return UsageDocument{}, err
	}
	probedDocument, err := normaliseUsageProbe(raw, probed, s.now())
	if err != nil {
		return UsageDocument{}, err
	}
	if probedDocument.FetchedAt != "" {
		document.FetchedAt = probedDocument.FetchedAt
	}
	document.Providers = append(probedDocument.Providers, document.Providers...)
	if len(document.Providers) > maxUsageProviders {
		return UsageDocument{}, errors.New("account usage response lists too many providers")
	}
	return document, nil
}

func (s *Server) usageProviders(ctx context.Context) ([]string, []ProviderUsage) {
	if s.Catalogue == nil {
		return append([]string(nil), usageProbeProviders...), nil
	}
	body, err := s.Catalogue(ctx)
	if err != nil {
		return append([]string(nil), usageProbeProviders...), nil
	}
	var catalogue struct {
		Providers []struct {
			Slug          string `json:"slug"`
			Authenticated bool   `json:"authenticated"`
		} `json:"providers"`
	}
	if json.Unmarshal(body, &catalogue) != nil || catalogue.Providers == nil {
		return append([]string(nil), usageProbeProviders...), nil
	}
	var probed []string
	var unsupported []ProviderUsage
	seen := map[string]bool{}
	for _, p := range catalogue.Providers {
		if !p.Authenticated || !providerRe.MatchString(p.Slug) || seen[p.Slug] {
			continue
		}
		seen[p.Slug] = true
		if supportsUsageProbe(p.Slug) {
			probed = append(probed, p.Slug)
			continue
		}
		unsupported = append(unsupported, unsupportedUsage(p.Slug))
	}
	sort.Slice(unsupported, func(i, j int) bool { return unsupported[i].Provider < unsupported[j].Provider })
	return probed, unsupported
}

func supportsUsageProbe(provider string) bool {
	for _, candidate := range usageProbeProviders {
		if provider == candidate {
			return true
		}
	}
	return false
}

func unsupportedUsage(provider string) ProviderUsage {
	reason := "no account-usage endpoint for this provider"
	return ProviderUsage{Provider: provider, Source: "unsupported", Windows: []UsageWindow{}, Details: []string{}, UnavailableReason: &reason}
}

func (s *Server) usage(w http.ResponseWriter, r *http.Request) {
	force := strings.Contains(strings.ToLower(r.Header.Get("Cache-Control")), "no-cache")
	document, err := s.providerUsage(r.Context(), force)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, "USAGE_PROBE_TIMEOUT", "the account usage probe timed out")
			return
		}
		s.logf("account usage probe failed")
		writeError(w, http.StatusBadGateway, "USAGE_PROBE_FAILED", "the account usage probe failed")
		return
	}
	writeJSON(w, http.StatusOK, document)
}

type rawUsageProbe struct {
	FetchedAt string `json:"fetchedAt"`
	Providers []struct {
		Provider          string          `json:"provider"`
		Usage             json.RawMessage `json:"usage"`
		UnavailableReason string          `json:"unavailableReason"`
	} `json:"providers"`
}

func normaliseUsageProbe(raw []byte, requested []string, now time.Time) (UsageDocument, error) {
	if len(raw) == 0 || len(raw) > maxUsageOutput {
		return UsageDocument{}, errors.New("account usage response size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var result rawUsageProbe
	if err := decoder.Decode(&result); err != nil {
		return UsageDocument{}, fmt.Errorf("account usage response is not JSON: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return UsageDocument{}, errors.New("account usage response has trailing data")
	}
	if len(result.Providers) > maxUsageProviders {
		return UsageDocument{}, errors.New("account usage response lists too many providers")
	}
	fetchedAt := normaliseTime(result.FetchedAt)
	if fetchedAt == "" {
		fetchedAt = now.UTC().Format(time.RFC3339)
	}
	known := map[string]bool{}
	for _, provider := range requested {
		known[provider] = true
	}
	got := make(map[string]ProviderUsage, len(result.Providers))
	for _, rawProvider := range result.Providers {
		if !known[rawProvider.Provider] || got[rawProvider.Provider].Provider != "" {
			return UsageDocument{}, errors.New("account usage response has an unexpected provider")
		}
		if rawProvider.UnavailableReason != "" {
			// The Python probe only emits fixed reasons, but this is still an
			// untrusted process boundary: never relay a string supplied in its
			// output as an upstream diagnostic.
			got[rawProvider.Provider] = unavailableUsage(rawProvider.Provider, "account usage is unavailable")
			continue
		}
		got[rawProvider.Provider] = normaliseProviderUsage(rawProvider.Provider, rawProvider.Usage)
	}
	document := UsageDocument{FetchedAt: fetchedAt, Providers: make([]ProviderUsage, 0, len(requested))}
	for _, provider := range requested {
		if item, ok := got[provider]; ok {
			document.Providers = append(document.Providers, item)
		} else {
			document.Providers = append(document.Providers, unavailableUsage(provider, "the account usage probe returned no result"))
		}
	}
	return document, nil
}

func unavailableUsage(provider, reason string) ProviderUsage {
	reason = boundedText(reason, 200)
	return ProviderUsage{Provider: provider, Source: "unavailable", Windows: []UsageWindow{}, Details: []string{}, UnavailableReason: &reason}
}

func normaliseProviderUsage(provider string, raw json.RawMessage) ProviderUsage {
	value := any(nil)
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if len(raw) == 0 || decoder.Decode(&value) != nil {
		return unavailableUsage(provider, "the account usage response was invalid")
	}
	root, ok := value.(map[string]any)
	if !ok || root == nil {
		return unavailableUsage(provider, "the account usage response was unavailable")
	}
	if stringValue(root, "unavailableReason", "unavailable_reason", "error") != "" {
		// The raw probe payload is derived from upstream code. Its diagnostic
		// text never crosses this boundary, even as an `unavailableReason`.
		return unavailableUsage(provider, "account usage is unavailable")
	}
	plan := optional(boundedText(stringValue(root, "plan", "planType", "plan_type"), 64))
	item := ProviderUsage{
		Provider: provider,
		Source:   defaultUsageSource(provider),
		Plan:     plan,
		Windows:  usageWindows(root),
		Details:  usageDetails(root),
	}
	if item.Windows == nil {
		item.Windows = []UsageWindow{}
	}
	if item.Details == nil {
		item.Details = []string{}
	}
	return item
}

func defaultUsageSource(provider string) string {
	switch provider {
	case "anthropic":
		return "oauth_usage_api"
	case "openrouter":
		return "credits_api"
	default:
		return "usage_api"
	}
}

func usageWindows(root map[string]any) []UsageWindow {
	var windows []UsageWindow
	for _, key := range []string{"windows", "limits", "rateLimits", "rate_limits", "usage"} {
		if child, ok := root[key]; ok {
			collectUsageWindows(child, key, 0, &windows)
		}
	}
	if len(windows) == 0 {
		collectUsageWindows(root, "", 0, &windows)
	}
	if len(windows) > maxUsageWindows {
		windows = windows[:maxUsageWindows]
	}
	return windows
}

func collectUsageWindows(value any, hint string, depth int, windows *[]UsageWindow) {
	if depth > 5 || len(*windows) >= maxUsageWindows {
		return
	}
	switch item := value.(type) {
	case []any:
		for _, child := range item {
			collectUsageWindows(child, hint, depth+1, windows)
		}
	case map[string]any:
		percent, hasPercent := numberValue(item, "usedPercent", "used_percent", "utilization", "usagePercent", "usage_percent")
		reset := normaliseTime(stringValue(item, "resetAt", "reset_at", "resetsAt", "resets_at"))
		if hasPercent || reset != "" {
			label := boundedText(stringValue(item, "label", "name", "window"), 64)
			if label == "" {
				label = boundedText(strings.ReplaceAll(hint, "_", " "), 64)
			}
			if label == "" {
				label = "Usage"
			}
			var used *float64
			if hasPercent {
				percent = math.Max(0, math.Min(100, percent))
				used = &percent
			}
			var resetAt *string
			if reset != "" {
				resetAt = &reset
			}
			// Free-form upstream descriptions are deliberately not relayed: they
			// can be transport diagnostics. The bounded public labels and numeric
			// percentages are sufficient for this read-only card.
			*windows = append(*windows, UsageWindow{Label: label, UsedPercent: used, ResetAt: resetAt, Detail: nil})
			return
		}
		keys := make([]string, 0, len(item))
		for key := range item {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			collectUsageWindows(item[key], key, depth+1, windows)
		}
	}
}

// relayedUsageDetail matches the only free-form upstream detail lines worth
// showing: a Codex credits balance and banked resets. They explain why runs
// still pass on an account whose window reads 100 %. Anything else in
// `details` can carry transport diagnostics and stays on the host.
var relayedUsageDetail = regexp.MustCompile(`^(Credits balance: (\$[0-9]+\.[0-9]{2}|unlimited)|You have [0-9]+ resets? banked[ -A-Za-z/]*)$`)

func usageDetails(root map[string]any) []string {
	var details []string
	for _, key := range []string{"total_credits", "totalCredits", "total_usage", "totalUsage", "remaining_credits", "remainingCredits"} {
		if value, ok := numberValue(root, key); ok && len(details) < maxUsageDetails {
			details = append(details, strings.ReplaceAll(key, "_", " ")+": "+fmt.Sprint(value))
		}
	}
	if upstream, ok := root["details"].([]any); ok {
		for _, item := range upstream {
			text, isText := item.(string)
			if !isText || len(details) >= maxUsageDetails {
				continue
			}
			if line := boundedText(text, 120); relayedUsageDetail.MatchString(line) {
				details = append(details, line)
			}
		}
	}
	if len(details) > maxUsageDetails {
		details = details[:maxUsageDetails]
	}
	return details
}

func stringValue(item map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := item[key].(string); ok {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func numberValue(item map[string]any, keys ...string) (float64, bool) {
	for _, key := range keys {
		switch value := item[key].(type) {
		case json.Number:
			if number, err := value.Float64(); err == nil && !math.IsNaN(number) && !math.IsInf(number, 0) {
				return number, true
			}
		case float64:
			if !math.IsNaN(value) && !math.IsInf(value, 0) {
				return value, true
			}
		}
	}
	return 0, false
}

func normaliseTime(value string) string {
	if value == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return ""
	}
	return parsed.UTC().Format(time.RFC3339)
}

func boundedText(value string, max int) string {
	value = strings.TrimSpace(value)
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value)
	if len(value) > max {
		return value[:max]
	}
	return value
}
