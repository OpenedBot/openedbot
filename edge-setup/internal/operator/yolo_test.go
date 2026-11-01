package operator

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/yolohardline"
)

func yoloRoot(t *testing.T, slugs ...string) (string, yoloService) {
	t.Helper()
	root := t.TempDir()
	for _, slug := range slugs {
		if err := os.MkdirAll(filepath.Join(root, "profiles", slug, "plugins", approvalPolicyPlugin), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return root, yoloService{runtimeRoot: root, owner: fsx.Current(), logf: t.Logf}
}

func applied(scope string, profile *string) yoloApplied {
	l := yoloApplied{LeaseID: "5d0c7f3e-9a41-4b7e-8c2d-3f6a1b0e9d01", Scope: scope, Profile: profile, NotBefore: 100, ExpiresAt: 200, Protect: yolohardline.DefaultProtect()}
	l.Deny.Commands, l.Deny.Tools, l.Deny.Paths = []string{}, []string{}, []string{}
	return l
}

func TestYoloApplyWritesCoveredProfilesOnly(t *testing.T) {
	root, y := yoloRoot(t, "designer", "writer")
	designer := "designer"
	if err := y.apply(context.Background(), []yoloApplied{applied("bot", &designer)}); err != nil {
		t.Fatal(err)
	}
	file := func(slug, name string) string {
		return filepath.Join(root, "profiles", slug, "plugins", approvalPolicyPlugin, name)
	}
	info, err := os.Stat(file("designer", yoloFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("designer yolo.json: %v %v", err, info)
	}
	if rules, _ := os.ReadFile(file("designer", yoloHardlineFile)); string(rules) != string(yolohardline.JSON) {
		t.Fatal("hardline.json not installed with the lease")
	}
	if _, err := os.Stat(file("writer", yoloFile)); !os.IsNotExist(err) {
		t.Fatal("a profile no lease covers got a yolo.json")
	}
	var doc yoloDocument
	data, _ := os.ReadFile(file("designer", yoloFile))
	if json.Unmarshal(data, &doc) != nil || doc.V != 1 || len(doc.Leases) != 1 || strings.Contains(string(data), "grantedBy") {
		t.Fatalf("document %s", data)
	}
	// A runtime lease covers both; an empty set removes every file.
	if err := y.apply(context.Background(), []yoloApplied{applied("runtime", nil)}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file("writer", yoloFile)); err != nil {
		t.Fatal("runtime lease did not reach writer")
	}
	if err := y.apply(context.Background(), []yoloApplied{}); err != nil {
		t.Fatal(err)
	}
	for _, slug := range []string{"designer", "writer"} {
		if _, err := os.Stat(file(slug, yoloFile)); !os.IsNotExist(err) {
			t.Fatalf("%s kept its yolo.json after the set emptied", slug)
		}
	}
}

func TestYoloDrainClaimsAndAcknowledges(t *testing.T) {
	root, y := yoloRoot(t, "designer")
	dir := filepath.Join(root, "profiles", "designer", "plugins", approvalPolicyPlugin)
	good := `{"v":1,"eventId":"3c2b1a00-0000-4000-8000-000000000007","occurredAt":1793491307,"leaseId":"5d0c7f3e-9a41-4b7e-8c2d-3f6a1b0e9d01","gateKind":"plugin_tool","toolKey":"write_file","argsHash":"` + strings.Repeat("a", 64) + `"}`
	if err := os.WriteFile(filepath.Join(dir, yoloSpoolFile), []byte(good+"\n"+`{"v":1,"argsHash":"rm -rf build"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	records, err := y.drain(context.Background())
	if err != nil || len(records) != 1 || records[0].Profile != "designer" || records[0].EventID != "3c2b1a00-0000-4000-8000-000000000007" {
		t.Fatalf("drain: %v %+v", err, records)
	}
	// Not acknowledged: the same records come back, nothing is lost.
	again, _ := y.drain(context.Background())
	if len(again) != 1 {
		t.Fatalf("second drain %+v", again)
	}
	if err := y.drained(context.Background()); err != nil {
		t.Fatal(err)
	}
	if after, _ := y.drain(context.Background()); len(after) != 0 {
		t.Fatalf("drained records came back: %+v", after)
	}
}

func TestYoloApplyHandlerRefusesAnInvalidSet(t *testing.T) {
	var got []yoloApplied
	srv := httptest.NewServer((&Server{YoloApply: func(_ context.Context, leases []yoloApplied) error { got = leases; return nil }}).Handler())
	defer srv.Close()
	designer := "designer"
	thread := applied("thread", &designer)
	missingSession, _ := json.Marshal(map[string]any{"leases": []yoloApplied{thread}})
	unknownProtect := applied("runtime", nil)
	unknownProtect.Protect = []string{"nothing"}
	badProtect, _ := json.Marshal(map[string]any{"leases": []yoloApplied{unknownProtect}})
	for name, body := range map[string]string{
		"thread without session": string(missingSession),
		"unknown protection":     string(badProtect),
		"unknown field":          `{"leases":[],"admin":true}`,
		"no list":                `{}`,
	} {
		if status, _ := call(t, srv, "PUT", "/yolo", body); status != 400 {
			t.Errorf("%s: status %d", name, status)
		}
	}
	valid, _ := json.Marshal(map[string]any{"leases": []yoloApplied{applied("runtime", nil)}})
	if status, out := call(t, srv, "PUT", "/yolo", string(valid)); status != 200 || len(got) != 1 {
		t.Fatalf("valid set: %d %v", status, out)
	}
}
