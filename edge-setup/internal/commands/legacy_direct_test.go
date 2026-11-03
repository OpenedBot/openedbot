package commands

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/proxy"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

type fakeUnits struct {
	active, enabled bool
	stops, disables int
}

func (f *fakeUnits) IsActive(context.Context, string) (bool, error)  { return f.active, nil }
func (f *fakeUnits) IsEnabled(context.Context, string) (bool, error) { return f.enabled, nil }
func (f *fakeUnits) Stop(context.Context, ...string) error {
	f.stops++
	f.active = false
	return nil
}
func (f *fakeUnits) Disable(context.Context, ...string) error {
	f.disables++
	f.enabled = false
	return nil
}

func TestRetireManagedCaddy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Caddyfile")
	if err := os.WriteFile(path, []byte(proxy.ManagedMarker+"\nlegacy\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	u := &fakeUnits{active: true, enabled: true}
	if err := retireManagedCaddy(context.Background(), u, path); err != nil {
		t.Fatal(err)
	}
	if u.stops != 1 || u.disables != 1 {
		t.Fatalf("stop=%d disable=%d", u.stops, u.disables)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("managed Caddyfile survived: %v", err)
	}
}

func TestRetireManagedCaddyLeavesForeignFileAndServiceAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Caddyfile")
	foreign := "# customer configuration\n"
	if err := os.WriteFile(path, []byte(foreign), 0o600); err != nil {
		t.Fatal(err)
	}
	u := &fakeUnits{active: true, enabled: true}
	if err := retireManagedCaddy(context.Background(), u, path); err != nil {
		t.Fatal(err)
	}
	if u.stops != 0 || u.disables != 0 || !u.active || !u.enabled {
		t.Fatalf("foreign service was touched: %+v", u)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != foreign {
		t.Fatalf("foreign Caddyfile changed: %q, %v", got, err)
	}
}

type changingUFW struct {
	keepOpen bool
	commands []string
}

func (u *changingUFW) Run(_ context.Context, c exec.Cmd) (exec.Result, error) {
	u.commands = append(u.commands, c.String())
	if len(c.Args) == 2 && c.Args[0] == "status" && c.Args[1] == "numbered" {
		return exec.Result{Stdout: "Status: active\n[ 1] 22/tcp ALLOW IN Anywhere # Hermes-managed\n[ 2] 80/tcp ALLOW IN Anywhere # Hermes-managed\n[ 3] 443/tcp ALLOW IN Anywhere # Hermes-managed\n[ 4] 180/tcp ALLOW IN Anywhere # Hermes-managed\n"}, nil
	}
	if len(c.Args) == 1 && c.Args[0] == "status" {
		if u.keepOpen {
			return exec.Result{Stdout: "Status: active\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n"}, nil
		}
		return exec.Result{Stdout: "Status: active\n22/tcp ALLOW Anywhere\n"}, nil
	}
	return exec.Result{}, nil
}

func TestCloseLegacyDirectPortsKeepsSSH(t *testing.T) {
	r := &changingUFW{}
	if err := closeLegacyDirectPorts(context.Background(), r, "/test/ufw", true); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(r.commands, "\n")
	for _, want := range []string{"--force delete 3", "--force delete 2"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %s", want, joined)
		}
	}
	if strings.Contains(joined, "delete 1") {
		t.Fatalf("SSH rule was removed: %s", joined)
	}
	if strings.Contains(joined, "delete 4") {
		t.Fatalf("non-public managed rule was removed: %s", joined)
	}
}

func TestCloseLegacyDirectPortsRequiresProof(t *testing.T) {
	r := &changingUFW{}
	r.keepOpen = true
	if err := closeLegacyDirectPorts(context.Background(), r, "/test/ufw", true); err == nil || !strings.Contains(err.Error(), "still allows") {
		t.Fatalf("open ports were accepted: %v", err)
	}
}

type fakeLegacyTx struct {
	active             bool
	commits, rollbacks int
}

func (f *fakeLegacyTx) State() guard.State { return guard.State{Active: f.active} }
func (f *fakeLegacyTx) Commit(context.Context) error {
	f.commits++
	return nil
}
func (f *fakeLegacyTx) Rollback(context.Context) (string, error) {
	f.rollbacks++
	return "rolled-back", nil
}

func TestMigrateLegacyDirectRefusesForeignFirewallWithoutMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Caddyfile")
	foreign := "# customer configuration\n"
	if err := os.WriteFile(path, []byte(foreign), 0o600); err != nil {
		t.Fatal(err)
	}
	u := &fakeUnits{}
	tx := &fakeLegacyTx{active: true}
	r := &changingUFW{keepOpen: true}
	st := state.New("test")
	st.Mode = legacyDirectMode
	err := migrateLegacyDirectWith(context.Background(), r, st, u, tx, path, "/test/ufw", true)
	if err == nil || !strings.Contains(err.Error(), "without mutation") {
		t.Fatalf("foreign exposure was accepted: %v", err)
	}
	if u.stops != 0 || u.disables != 0 || tx.commits != 0 || tx.rollbacks != 0 {
		t.Fatalf("foreign exposure was mutated: units=%+v tx=%+v", u, tx)
	}
	for _, command := range r.commands {
		if strings.Contains(command, " delete ") {
			t.Fatalf("firewall was mutated: %v", r.commands)
		}
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil || string(got) != foreign {
		t.Fatalf("foreign Caddyfile changed: %q, %v", got, readErr)
	}
}

func TestMigrateLegacyDirectRefusesActiveForeignCaddyWithoutMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Caddyfile")
	foreign := "# customer configuration\n"
	if err := os.WriteFile(path, []byte(foreign), 0o600); err != nil {
		t.Fatal(err)
	}
	u := &fakeUnits{active: true, enabled: true}
	tx := &fakeLegacyTx{active: true}
	r := &changingUFW{}
	st := state.New("test")
	st.Mode = legacyDirectMode
	err := migrateLegacyDirectWith(context.Background(), r, st, u, tx, path, "/test/ufw", true)
	if err == nil || !strings.Contains(err.Error(), "without mutation") {
		t.Fatalf("foreign Caddy was accepted: %v", err)
	}
	if u.stops != 0 || u.disables != 0 || tx.commits != 0 || tx.rollbacks != 0 {
		t.Fatalf("foreign Caddy was mutated: units=%+v tx=%+v", u, tx)
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil || string(got) != foreign {
		t.Fatalf("foreign Caddyfile changed: %q, %v", got, readErr)
	}
}

func TestMigrateLegacyDirectRetiresManagedExposure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Caddyfile")
	if err := os.WriteFile(path, []byte(proxy.ManagedMarker+"\nlegacy\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	u := &fakeUnits{active: true, enabled: true}
	tx := &fakeLegacyTx{}
	r := &changingUFW{}
	st := state.New("test")
	st.Mode = legacyDirectMode
	if err := migrateLegacyDirectWith(context.Background(), r, st, u, tx, path, "/test/ufw", true); err != nil {
		t.Fatal(err)
	}
	if u.active || u.enabled || u.stops != 1 || u.disables != 1 {
		t.Fatalf("managed Caddy was not retired: %+v", u)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("managed Caddyfile survived: %v", err)
	}
	joined := strings.Join(r.commands, "\n")
	if !strings.Contains(joined, "--force delete 3") || !strings.Contains(joined, "--force delete 2") {
		t.Fatalf("managed public rules survived: %s", joined)
	}
	if st.Mode != legacyDirectMode {
		t.Fatalf("cleanup helper recorded connector state itself: %s", st.Mode)
	}
}
