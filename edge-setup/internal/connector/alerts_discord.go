package connector

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type discordAlert struct {
	Embeds          []discordAlertEmbed `json:"embeds"`
	AllowedMentions struct {
		Parse []string `json:"parse"`
	} `json:"allowed_mentions"`
}

type discordAlertEmbed struct {
	Title       string              `json:"title"`
	Description string              `json:"description"`
	Color       int                 `json:"color"`
	Fields      []discordAlertField `json:"fields"`
	Timestamp   string              `json:"timestamp"`
	Footer      struct {
		Text string `json:"text"`
	} `json:"footer"`
}

type discordAlertField struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Inline bool   `json:"inline"`
}

// The card comes from two fixed components, observed timestamps and the
// link context (tier, instance, openedbot host, owner): display data
// openedbot declared, bounded and stripped of markup, never an error,
// a credential or an arbitrary mention.
// Discord owns typography and responsive layout; color reinforces explicit words.
// Native schema and limits: https://docs.discord.com/developers/resources/message#embed-object
// One embed, six short fields at most; no content or external image is needed.
func renderDiscordAlert(states map[string]alertState, context AlertContext, now time.Time) []byte {
	embed := discordAlertEmbed{
		Title:       "Runtime rétabli",
		Description: "Les services concernés sont de nouveau disponibles.",
		Color:       0x23875B,
		Timestamp:   now.UTC().Format(time.RFC3339),
	}
	embed.Footer.Text = "Surveillance Hermes"
	if link, ok := states["link"]; ok && !link.available {
		embed.Title = "Connexion interrompue"
		embed.Description = "openedbot ne peut plus joindre le runtime. La reconnexion est automatique."
		embed.Color = 0xD83C3E
	} else if operator, ok := states["operator"]; ok && !operator.available {
		embed.Title = "Administration indisponible"
		embed.Description = "La gestion des fournisseurs et des outils est suspendue. Une nouvelle vérification est automatique."
		embed.Color = 0xD83C3E
	}
	embed.Title = "[" + alertText(context.Environment) + "] " + embed.Title
	embed.Fields = append(embed.Fields,
		discordAlertField{Name: "Environnement", Value: alertText(context.Environment), Inline: true},
		discordAlertField{Name: "Instance", Value: alertText(context.Instance), Inline: true},
		discordAlertField{Name: "openedbot", Value: alertText(alertHost(context.Openedbot)), Inline: true},
		discordAlertField{Name: "Utilisateur", Value: alertUser(context), Inline: false},
	)
	for _, component := range []string{"link", "operator"} {
		s, ok := states[component]
		if !ok {
			continue
		}
		name := "Connexion openedbot"
		if component == "operator" {
			name = "Administration Hermes"
		}
		status, end := "Indisponible", now
		if s.available {
			status, end = "Rétabli", s.recoveredAt
		}
		value := fmt.Sprintf("**%s**\nDébut : <t:%d:T>\nDurée : %s", status, s.startedAt.Unix(), alertDuration(end.Sub(s.startedAt)))
		if s.available {
			value += fmt.Sprintf("\nRetour : <t:%d:T>", end.Unix())
		}
		embed.Fields = append(embed.Fields, discordAlertField{Name: name, Value: value, Inline: true})
	}
	payload := discordAlert{Embeds: []discordAlertEmbed{embed}}
	payload.AllowedMentions.Parse = []string{}
	body, _ := json.Marshal(payload)
	return body
}

// alertText bounds a declared string and neutralises Discord markup and line
// breaks; empty renders as « inconnu ».
func alertText(text string) string {
	text = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(text))
	if text == "" {
		return "inconnu"
	}
	if len(text) > 200 {
		text = text[:200] + "…"
	}
	return strings.NewReplacer("*", "\\*", "_", "\\_", "`", "\\`", "~", "\\~", "|", "\\|", "<", "\\<", ">", "\\>", "@", "@\u200b").Replace(text)
}

// alertHost keeps the host of an origin, so a card names the openedbot
// without echoing a full URL.
func alertHost(origin string) string {
	if u, err := url.Parse(strings.TrimSpace(origin)); err == nil && u.Host != "" {
		return u.Host
	}
	return origin
}

func alertUser(context AlertContext) string {
	if context.OwnerEmail == "" && context.Organization == "" {
		return "inconnu"
	}
	if context.Organization == "" {
		return alertText(context.OwnerEmail)
	}
	return alertText(context.OwnerEmail) + " / " + alertText(context.Organization)
}

func alertDuration(duration time.Duration) string {
	if duration < time.Second {
		return "moins d’une seconde"
	}
	seconds := int64(duration / time.Second)
	if seconds < 60 {
		return fmt.Sprintf("%d s", seconds)
	}
	if seconds < 3600 {
		return fmt.Sprintf("%d min %02d s", seconds/60, seconds%60)
	}
	return fmt.Sprintf("%d h %02d min", seconds/3600, seconds%3600/60)
}
