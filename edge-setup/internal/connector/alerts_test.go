package connector

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// pilotedAlerts returns alerts whose own clock is the returned pointer, so a
// test states outage durations instead of sleeping through them.
func pilotedAlerts(t *testing.T, logf func(string, ...any)) (*Alerts, *time.Time) {
	t.Helper()
	a, err := NewAlerts("https://discord.com/api/webhooks/123/test-secret", logf)
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Now()
	a.now = func() time.Time { return clock }
	return a, &clock
}

func TestAlertsDeduplicateIncidentsAndSendRecovery(t *testing.T) {
	var bodies []string
	a, clock := pilotedAlerts(t, func(string, ...any) {})
	a.http.Transport = readinessTransport(func(r *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(b))
		if r.URL.Query().Get("wait") != "true" {
			t.Fatal("delivery must be acknowledged")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	a.Update("link", true)
	a.flush(context.Background(), *clock)
	if len(bodies) != 0 {
		t.Fatal("healthy startup is not an incident")
	}
	a.Update("link", false)
	a.flush(context.Background(), *clock)
	if len(bodies) != 0 {
		t.Fatal("an unconfirmed loss is not an incident yet")
	}
	*clock = clock.Add(alertConfirmDelay)
	a.Update("link", false)
	a.flush(context.Background(), *clock)
	if len(bodies) != 1 || !strings.Contains(bodies[0], "Connexion interrompue") || !strings.Contains(bodies[0], `"parse":[]`) {
		t.Fatal(bodies)
	}
	// The card carries the confirmed duration, not the age of the detection.
	if !strings.Contains(bodies[0], "1 min 00 s") {
		t.Fatal(bodies[0])
	}
	*clock = clock.Add(time.Minute)
	a.Update("link", true)
	a.flush(context.Background(), *clock)
	if len(bodies) != 2 || !strings.Contains(bodies[1], "Runtime rétabli") {
		t.Fatal(bodies)
	}
}

// The deployment case: openedbot is replaced, every connector socket closes, the host
// reconnects within seconds. Nothing is sent, and the next real outage still is.
func TestAlertsStaySilentWhenTheLinkComesBackBeforeConfirmation(t *testing.T) {
	var bodies []string
	a, clock := pilotedAlerts(t, func(string, ...any) {})
	a.http.Transport = readinessTransport(func(r *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(b))
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	a.Update("link", false)
	*clock = clock.Add(5 * time.Second)
	a.flush(context.Background(), *clock)
	a.Update("link", true)
	a.flush(context.Background(), *clock)
	*clock = clock.Add(alertConfirmDelay + time.Minute)
	a.flush(context.Background(), *clock)
	if len(bodies) != 0 {
		t.Fatal("a reconnection shorter than the delay must not be announced", bodies)
	}
	a.Update("link", false)
	*clock = clock.Add(alertConfirmDelay)
	a.flush(context.Background(), *clock)
	if len(bodies) != 1 || !strings.Contains(bodies[0], "Connexion interrompue") {
		t.Fatal("a real outage after a silent one must still be announced", bodies)
	}
}

// A component still inside its delay is named by a card another component
// triggers: a recovery must never claim everything is back while one is down.
func TestAlertsNameAnUnconfirmedComponentOnACardItDoesNotTrigger(t *testing.T) {
	var bodies []string
	a, clock := pilotedAlerts(t, func(string, ...any) {})
	a.http.Transport = readinessTransport(func(r *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(b))
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	a.Update("link", false)
	*clock = clock.Add(alertConfirmDelay)
	a.flush(context.Background(), *clock)
	if len(bodies) != 1 {
		t.Fatal(bodies)
	}
	// The operator falls, then the link returns inside the operator's delay.
	a.Update("operator", false)
	*clock = clock.Add(time.Minute)
	a.Update("link", true)
	a.flush(context.Background(), *clock)
	if len(bodies) != 2 || !strings.Contains(bodies[1], "Administration indisponible") {
		t.Fatal("the card must name the component still down", bodies)
	}
	// Named once, the operator does not trigger a second card of its own.
	*clock = clock.Add(alertConfirmDelay + time.Minute)
	a.flush(context.Background(), *clock)
	if len(bodies) != 2 {
		t.Fatal("an announced incident must not repeat", bodies)
	}
}

func TestAlertsKeepNetworkFailuresPendingWithoutLeakingWebhook(t *testing.T) {
	logs := ""
	a, clock := pilotedAlerts(t, func(f string, v ...any) { logs += fmt.Sprintf(f, v...) })
	attempts := 0
	a.http.Transport = readinessTransport(func(r *http.Request) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, errors.New("test-secret connection failed")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	a.Update("operator", false)
	*clock = clock.Add(alertConfirmDelay)
	a.flush(context.Background(), *clock)
	a.flush(context.Background(), clock.Add(time.Second))
	if attempts != 1 {
		t.Fatal("retry storm")
	}
	// Confirmed, then recovered before delivery: still reported, as recovered.
	*clock = clock.Add(time.Second)
	a.Update("operator", true)
	a.flush(context.Background(), clock.Add(time.Minute))
	if attempts != 2 || !strings.Contains(logs, "alert delivered") || strings.Contains(logs, "test-secret") {
		t.Fatal(logs, attempts)
	}
}

func TestAlertsRespectRetryAfterAndRefuseRedirects(t *testing.T) {
	a, clock := pilotedAlerts(t, func(string, ...any) {})
	attempts := 0
	a.http.Transport = readinessTransport(func(r *http.Request) (*http.Response, error) {
		attempts++
		return &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": {"120"}}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	a.Update("link", false)
	*clock = clock.Add(alertConfirmDelay)
	a.flush(context.Background(), *clock)
	a.flush(context.Background(), clock.Add(time.Minute))
	if attempts != 1 {
		t.Fatal(attempts)
	}
	a.flush(context.Background(), clock.Add(2*time.Minute))
	if attempts != 2 {
		t.Fatal(attempts)
	}
	if a.http.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("redirect exposes credential")
	}
	for _, endpoint := range []string{"http://discord.com/api/webhooks/123/token", "https://example.com/api/webhooks/123/token", "https://discord.com/api/webhooks/123/token?x=1"} {
		if _, err := NewAlerts(endpoint, func(string, ...any) {}); err == nil {
			t.Fatal("accepted invalid endpoint")
		}
	}
}
