package connector

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Alerts reports only fixed health states, never errors, tokens, URLs or run data.
// Pending incidents survive a network outage in memory; journald is the durable log.
// One worker, two slots and a one-minute minimum interval bound retries and flapping.
type Alerts struct {
	mu           sync.Mutex
	endpoint     string
	http         *http.Client
	logf         func(string, ...any)
	states       map[string]alertState
	next         time.Time
	now          func() time.Time
	context      AlertContext
	confirmAfter time.Duration
}

// alertConfirmDelay is how long a component must stay unavailable before the
// loss becomes a card. Replacing the openedbot process closes every connector
// WebSocket, the host reconnects within a second, and nobody has anything to do
// with that card: alerting on it trains the reader to ignore the channel. A
// shorter outage is therefore never sent at all, neither its loss nor its
// recovery, and journald keeps the durable trace either way.
//
// 60 s sits just above what openedbot itself treats as a real disconnection (the
// worker sweep marks a connector runtime disconnected after 45 s) and well
// under the exponential reconnect ceiling of 60 s that a genuinely down peer
// reaches. A real outage is late by one minute; a rolling restart is silent.
const alertConfirmDelay = 60 * time.Second

// AlertContext names, on every card, which openedbot and which host the
// incident concerns: several deployments post to one Discord channel and one
// VPS can carry a dev and a prod link. Unknown fields render as « inconnu ».
type AlertContext struct {
	// Environment is dev, preprod or prod, as openedbot declared it.
	Environment string
	// Instance is the connector instance name (default or --name).
	Instance string
	// openedbot is the origin of the openedbot behind the link; only its host
	// is rendered.
	Openedbot string
	// OwnerEmail and Organization identify whose runtime this is.
	OwnerEmail   string
	Organization string
}

type alertState struct {
	available, incident, dirty bool
	// announced is true once a card has named this incident. It gates the
	// confirmation delay (an announced incident reports its recovery at once)
	// and it is cleared by the next fall, which starts a new cycle.
	announced              bool
	revision               uint64
	startedAt, recoveredAt time.Time
}

var discordWebhookPath = regexp.MustCompile(`^/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$`)

func NewAlerts(endpoint string, logf func(string, ...any)) (*Alerts, error) {
	u, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || u.Scheme != "https" || u.Host != "discord.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !discordWebhookPath.MatchString(u.Path) {
		return nil, errors.New("alert webhook must be an HTTPS Discord webhook URL")
	}
	u.RawQuery = "wait=true"
	return &Alerts{endpoint: u.String(), logf: logf, now: time.Now, states: map[string]alertState{}, confirmAfter: alertConfirmDelay, http: &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

// SetContext replaces the context rendered on the next cards. It is safe
// from any goroutine and never resets an incident.
func (a *Alerts) SetContext(context AlertContext) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.context = context
}

// Update is non-blocking with respect to network I/O and accepts a closed component set.
func (a *Alerts) Update(component string, available bool) {
	if component != "link" && component != "operator" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	s, exists := a.states[component]
	if exists && s.available == available {
		return
	}
	if !available {
		s.startedAt = a.now()
		s.recoveredAt = time.Time{}
		s.announced = false
	} else if s.incident {
		s.recoveredAt = a.now()
	}
	s.available = available
	s.incident = s.incident || !available
	s.dirty = s.incident
	s.revision++
	a.states[component] = s
}

func (a *Alerts) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			a.flush(ctx, now)
		}
	}
}

func (a *Alerts) flush(ctx context.Context, now time.Time) {
	a.mu.Lock()
	if now.Before(a.next) {
		a.mu.Unlock()
		return
	}
	pending := map[string]alertState{}
	visible := map[string]alertState{}
	for _, component := range []string{"link", "operator"} {
		s := a.states[component]
		if !s.incident {
			continue
		}
		// Never announced, back, and the WHOLE outage was shorter than the
		// confirmation delay: it never happened as far as the channel is
		// concerned. Forgetting it here is what keeps a deployment silent.
		// A long outage whose card could not be delivered is NOT forgotten:
		// it is still reported, as a recovered incident, once Discord answers.
		if !s.announced && s.available && s.recoveredAt.Sub(s.startedAt) < a.confirmAfter {
			s.incident, s.dirty = false, false
			a.states[component] = s
			continue
		}
		if !s.available || s.dirty {
			visible[component] = s
		}
		// A component still inside its delay is shown on a card that another
		// component triggers, but it never triggers one itself: a green card
		// must not claim everything is back while this one is down.
		if s.dirty && (s.announced || now.Sub(s.startedAt) >= a.confirmAfter) {
			pending[component] = s
		}
	}
	if len(pending) == 0 {
		a.mu.Unlock()
		return
	}
	a.next = now.Add(time.Minute)
	alertContext := a.context
	a.mu.Unlock()
	body := renderDiscordAlert(visible, alertContext, now)
	req, _ := http.NewRequestWithContext(ctx, "POST", a.endpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		// net/url errors embed the secret webhook URL: never log them.
		if ctx.Err() == nil {
			a.logf("alert delivery failed: network error; retry pending")
		}
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if seconds, err := strconv.ParseFloat(resp.Header.Get("Retry-After"), 64); err == nil && seconds > 60 && seconds < 86400 {
			a.mu.Lock()
			a.next = now.Add(time.Duration(seconds * float64(time.Second)))
			a.mu.Unlock()
		}
		a.logf("alert delivery failed: HTTP %d; retry pending", resp.StatusCode)
		return
	}
	a.mu.Lock()
	// Every component the card NAMES is settled, not only those that triggered
	// the send: one card answers for all of them, and a second would repeat it.
	for component, sent := range visible {
		current := a.states[component]
		if current.revision != sent.revision {
			continue
		}
		current.dirty = false
		if current.available {
			// The cycle is closed by its recovery card; the next fall opens a
			// new one with its own delay.
			current.incident, current.announced = false, false
		} else {
			current.announced = true
		}
		a.states[component] = current
	}
	a.mu.Unlock()
	a.logf("alert delivered: %d health state(s)", len(visible))
}
