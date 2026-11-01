package operator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// The inventory pages the Dashboard route per profile, keeps identifiers,
// owning profile and start time only, and never grows past its bound.
func TestSessionsInventoryIsBoundedAndCarriesNoContent(t *testing.T) {
	s, _, srv := newServer(t, catalogueOK)
	s.Probe = func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		if verb != "profiles" {
			t.Fatalf("unexpected verb %s", verb)
		}
		return []byte(`{"multiplex":true,"profiles":[{"name":"scout"},{"name":"BAD SLUG"}]}`), nil
	}
	pages := map[string]int{}
	s.Sessions = func(_ context.Context, profile string, offset int) ([]byte, error) {
		pages[profile]++
		total := 150
		if profile == "scout" {
			total = 1
		}
		var rows []string
		for i := offset; i < total && i < offset+100; i++ {
			rows = append(rows, fmt.Sprintf(`{"id":"sess-%s-%d","started_at":1757000000.5,"title":"private title","system_prompt":"secret","model":"gpt"}`, profile, i))
		}
		body := "["
		for i, row := range rows {
			if i > 0 {
				body += ","
			}
			body += row
		}
		return []byte(fmt.Sprintf(`{"sessions":%s],"total":%d,"limit":100,"offset":%d}`, body, total, offset)), nil
	}
	status, out := call(t, srv, "GET", "/sessions-inventory", "")
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	sessions := out["sessions"].([]any)
	if len(sessions) != 151 || out["total"].(float64) != 151 || out["truncated"] != false {
		t.Fatalf("inventory %v", out)
	}
	if pages[""] != 2 || pages["scout"] != 1 || len(pages) != 2 {
		t.Fatalf("paging %v", pages)
	}
	first := sessions[0].(map[string]any)
	if first["id"] != "sess--0" || first["profile"] != "default" || first["createdAt"] != "2025-09-04T15:33:20Z" || len(first) != 3 {
		t.Fatalf("row %v", first)
	}
	last := sessions[150].(map[string]any)
	if last["profile"] != "scout" {
		t.Fatalf("named profile row %v", last)
	}
	raw, _ := json.Marshal(out)
	for _, forbidden := range []string{"private title", "secret", "gpt", "BAD SLUG"} {
		if hasText(string(raw), forbidden) {
			t.Fatalf("inventory leaks %q", forbidden)
		}
	}
}

func TestSessionsInventoryTruncatesAtItsBound(t *testing.T) {
	s, _, srv := newServer(t, catalogueOK)
	s.Sessions = func(_ context.Context, _ string, offset int) ([]byte, error) {
		body := ""
		for i := offset; i < offset+100; i++ {
			if body != "" {
				body += ","
			}
			body += fmt.Sprintf(`{"id":"s%d","started_at":1}`, i)
		}
		return []byte(fmt.Sprintf(`{"sessions":[%s],"total":100000,"limit":100,"offset":%d}`, body, offset)), nil
	}
	status, out := call(t, srv, "GET", "/sessions-inventory", "")
	if status != 200 || len(out["sessions"].([]any)) != MaxSessionsInventory || out["truncated"] != true {
		t.Fatalf("%d %v", status, out["truncated"])
	}
}

func TestSessionsInventoryFailsClosedAndIsClaimedOnlyWhenWired(t *testing.T) {
	s, _, srv := newServer(t, catalogueOK)
	if status, _ := call(t, srv, "GET", "/sessions-inventory", ""); status != 404 {
		t.Fatalf("unwired operator served the inventory: %d", status)
	}
	if _, out := call(t, srv, "GET", "/capabilities", ""); hasText(fmt.Sprint(out["features"]), "sessions_inventory") {
		t.Fatal("feature claimed without a reader")
	}
	s.Sessions = func(context.Context, string, int) ([]byte, error) {
		return nil, errors.New("gateway down: /srv/hermes/secret")
	}
	status, out := call(t, srv, "GET", "/sessions-inventory", "")
	if status != 502 || out["error"].(map[string]any)["code"] != "HOST_UNAVAILABLE" || hasText(fmt.Sprint(out), "/srv/hermes") {
		t.Fatalf("%d %v", status, out)
	}
	if _, out := call(t, srv, "GET", "/capabilities", ""); !hasText(fmt.Sprint(out["features"]), "sessions_inventory") {
		t.Fatal("feature not claimed although wired")
	}
}

func hasText(s, sub string) bool { return strings.Contains(s, sub) }
