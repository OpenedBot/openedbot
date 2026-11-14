package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "etc", "hermes", "hermes-setup.json")
	if f, err := LoadFrom(p, fsx.Current()); f != nil || err != nil {
		t.Fatalf("missing file: %v %v", f, err)
	}
	f := New("1.2.3")
	f.Mode = ModeConnector
	f.MarkPhase("base", "abc")
	f.PinsApplied["hermes"] = "0.22.2"
	if err := f.SaveTo(p, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	st, _ := fsx.Lstat(p)
	if st.Mode != 0o600 {
		t.Fatalf("mode %04o", st.Mode)
	}
	g, err := LoadFrom(p, fsx.Current())
	if err != nil {
		t.Fatal(err)
	}
	if g.Mode != ModeConnector || !g.PhaseDone("base", "abc") || g.PhaseDone("base", "other") || g.PinsApplied["hermes"] != "0.22.2" {
		t.Fatalf("%+v", g)
	}
}

func TestUnsupportedSchemaIsRefused(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.json")
	_ = os.WriteFile(p, []byte(`{"schema": 99}`), 0o600)
	_, err := LoadFrom(p, fsx.Current())
	if err == nil || !strings.Contains(err.Error(), "schema 99") {
		t.Fatalf("expected schema refusal, got %v", err)
	}
}

func TestWorldReadableStateIsRefused(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.json")
	_ = os.WriteFile(p, []byte(`{"schema": 1}`), 0o644)
	if _, err := LoadFrom(p, fsx.Current()); err == nil {
		t.Fatal("a 0644 state file must be refused")
	}
}

func TestSchemaOneHardeningMigratesConservatively(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.json")
	legacy := `{"schema":1,"ssh_hardening":true,"docker_enabled":true,"quarantine_user":"debian","phases":{"base":{},"harden":{}},"pins_applied":{}}`
	if err := os.WriteFile(p, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := LoadFrom(p, fsx.Current())
	if err != nil {
		t.Fatal(err)
	}
	if got.Schema != SchemaVersion || !got.Features.Sandbox || !got.Features.PersistentJournal ||
		!got.Features.Firewall || !got.Features.Fail2Ban || !got.Features.SSHHardening ||
		!got.Features.QuarantineCloudUser || len(got.Features.AllowedInbound) != 1 || got.Features.AllowedInbound[0] != "22/tcp" {
		t.Fatalf("legacy protections were not preserved: %+v", got.Features)
	}
}

func TestFeaturesMergeAndDelta(t *testing.T) {
	previous := Features{Firewall: true, AllowedInbound: []string{"22/tcp"}, SSHHardening: true}
	effective := previous
	effective.Merge(Features{Firewall: true, AllowedInbound: []string{"443/tcp"}, SudoLogging: true})
	if !effective.SSHHardening || len(effective.AllowedInbound) != 2 {
		t.Fatalf("merge disabled or lost an existing protection: %+v", effective)
	}
	delta := effective.NewComparedTo(previous)
	if !delta.Firewall || !delta.SudoLogging || delta.SSHHardening || len(delta.AllowedInbound) != 2 {
		t.Fatalf("unexpected delta: %+v", delta)
	}
}
