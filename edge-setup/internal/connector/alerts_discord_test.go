package connector

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestDiscordAlertCardGroupsComponentsAndKeepsActiveIncidentVisible(t *testing.T) {
	start := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	body := renderDiscordAlert(map[string]alertState{
		"link":                             {incident: true, startedAt: start},
		"operator":                         {incident: true, available: true, startedAt: start, recoveredAt: start.Add(74 * time.Second)},
		"https://secret.invalid/@everyone": {incident: true},
	}, AlertContext{}, start.Add(90*time.Second))
	var payload discordAlert
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Embeds) != 1 || len(payload.Embeds[0].Fields) != 6 || payload.AllowedMentions.Parse == nil || len(payload.AllowedMentions.Parse) != 0 {
		t.Fatalf("invalid bounded card: %s", body)
	}
	embed := payload.Embeds[0]
	// Context fields come first, then the components.
	embed.Fields = embed.Fields[4:]
	// Byte counts are conservative for Discord's character limits.
	if len(embed.Title) > 256 || len(embed.Description) > 4096 || len(embed.Footer.Text) > 2048 || len(body) > 6000 {
		t.Fatal("Discord embed limit exceeded")
	}
	for _, field := range embed.Fields {
		if len(field.Name) > 256 || len(field.Value) > 1024 {
			t.Fatal("Discord field limit exceeded")
		}
	}
	if embed.Title != "[inconnu] Connexion interrompue" || embed.Color != 0xD83C3E {
		t.Fatal("recovery must not hide an ongoing link incident", embed)
	}
	if !strings.Contains(embed.Fields[0].Value, "1 min 30 s") || !strings.Contains(embed.Fields[1].Value, "1 min 14 s") {
		t.Fatal("duration must end at observed recovery, not delivery", embed.Fields)
	}
	for _, forbidden := range []string{"secret.invalid", "@everyone", `"content"`} {
		if strings.Contains(string(body), forbidden) {
			t.Fatal("unexpected content", forbidden)
		}
	}
}

// The channel is shared by several openedbot deployments and a VPS can
// carry two links: every card says which tier, instance, origin and owner it
// is about, or « inconnu » for what the link never declared.
func TestDiscordAlertCardNamesEnvironmentInstanceAndOwner(t *testing.T) {
	start := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	states := map[string]alertState{"link": {incident: true, startedAt: start}}
	known := AlertContext{Environment: "prod", Instance: "default", OHB: "https://console.openedbot.app", OwnerEmail: "owner_1@example.com", Organization: "Acme <@everyone>"}
	var payload discordAlert
	if err := json.Unmarshal(renderDiscordAlert(states, known, start.Add(time.Second)), &payload); err != nil {
		t.Fatal(err)
	}
	embed := payload.Embeds[0]
	if embed.Title != "[prod] Connexion interrompue" {
		t.Fatal(embed.Title)
	}
	got := map[string]string{}
	for _, field := range embed.Fields {
		got[field.Name] = field.Value
	}
	if got["Environnement"] != "prod" || got["Instance"] != "default" || got["openedbot"] != "console.openedbot.app" {
		t.Fatalf("%+v", got)
	}
	if !strings.HasPrefix(got["Utilisateur"], "owner\\_1@\u200bexample.com / Acme") || strings.Contains(got["Utilisateur"], "<@everyone>") {
		t.Fatalf("owner must be named, markup and mentions neutralised: %q", got["Utilisateur"])
	}
	if err := json.Unmarshal(renderDiscordAlert(states, AlertContext{Instance: "dev"}, start.Add(time.Second)), &payload); err != nil {
		t.Fatal(err)
	}
	got = map[string]string{}
	for _, field := range payload.Embeds[0].Fields {
		got[field.Name] = field.Value
	}
	if payload.Embeds[0].Title != "[inconnu] Connexion interrompue" || got["Environnement"] != "inconnu" || got["Instance"] != "dev" || got["openedbot"] != "inconnu" || got["Utilisateur"] != "inconnu" {
		t.Fatalf("%q %+v", payload.Embeds[0].Title, got)
	}
}

func TestAlertsRecoveryKeepsObservedDurationAndNewIncidentResetsClock(t *testing.T) {
	a, _ := NewAlerts("https://discord.com/api/webhooks/123/test-secret", func(string, ...any) {})
	start := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	clock := start
	a.now = func() time.Time { return clock }
	var bodies []string
	a.http.Transport = readinessTransport(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(body))
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	// Durations are counted from the fall, not from the confirmation: an
	// incident announced at the delay reports the delay, and its recovery
	// reports everything it lasted.
	a.Update("operator", false)
	a.flush(context.Background(), start.Add(alertConfirmDelay))
	clock = start.Add(alertConfirmDelay + 17*time.Second)
	a.Update("operator", true)
	a.flush(context.Background(), start.Add(2*alertConfirmDelay))
	if len(bodies) != 2 || !strings.Contains(bodies[1], "1 min 17 s") || !strings.Contains(bodies[1], "Runtime rétabli") {
		t.Fatal(bodies)
	}
	for _, body := range bodies {
		t.Logf("preview-payload: %s", body)
	}
	clock = start.Add(4 * time.Minute)
	a.Update("operator", false)
	a.flush(context.Background(), clock.Add(alertConfirmDelay+4*time.Second))
	if len(bodies) != 3 || !strings.Contains(bodies[2], "1 min 04 s") || !strings.Contains(bodies[2], "Administration indisponible") {
		t.Fatal(bodies)
	}
}

func TestAlertsPartialRecoveryDoesNotAnnounceRuntimeRecovered(t *testing.T) {
	a, clock := pilotedAlerts(t, func(string, ...any) {})
	var lastBody string
	a.http.Transport = readinessTransport(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		lastBody = string(body)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})
	a.Update("link", false)
	a.Update("operator", false)
	*clock = clock.Add(alertConfirmDelay)
	a.flush(context.Background(), *clock)
	a.Update("operator", true)
	a.flush(context.Background(), clock.Add(time.Minute))
	if strings.Contains(lastBody, "Runtime rétabli") || !strings.Contains(lastBody, "Connexion interrompue") || !strings.Contains(lastBody, "Rétabli") {
		t.Fatal(lastBody)
	}
}
