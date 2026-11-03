package hermes

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/render"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

// serviceAccounts answers for the hermes service account with uid 998.
func serviceAccounts() account.Client {
	fake := exectest.NewFake().On("/usr/bin/getent passwd hermes", exec.Result{Stdout: "hermes:x:998:998::/home/hermes:/usr/sbin/nologin\n"})
	return account.Client{Runner: fake, Lookup: func(name string) (*user.User, error) {
		if name != "hermes" {
			return nil, user.UnknownUserError(name)
		}
		return &user.User{Username: name, Uid: "998", Gid: "998"}, nil
	}}
}

func resolvConf(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "resolv.conf")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// An upgrade and `audit` compare the installed unit to the one `up` writes, so
// DesiredGatewayUnit must hand render.GatewayUnit the parameters `up` hands it:
// the sandbox variant of the recorded state, the uid of the service account and
// the resolver exception of resolv.conf.
func TestDesiredGatewayUnitRendersWhatUpWrites(t *testing.T) {
	metadata := netip.MustParseAddr("169.254.169.254")
	for _, c := range []struct {
		name     string
		sandbox  bool
		resolv   string
		resolver []netip.Addr
	}{
		{"local variant behind the resolved stub", false, "nameserver 127.0.0.53\n", nil},
		{"docker variant behind the resolved stub", true, "nameserver 127.0.0.53\n", nil},
		{"local variant, link-local resolver", false, "nameserver 169.254.169.254\n", []netip.Addr{metadata}},
		{"docker variant, link-local resolver", true, "nameserver 169.254.169.254\n", []netip.Addr{metadata}},
	} {
		got, err := DesiredGatewayUnit(context.Background(), serviceAccounts(), &state.File{Features: state.Features{Sandbox: c.sandbox}}, resolvConf(t, c.resolv), nil)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		want, err := render.GatewayUnit(render.GatewayParams{DockerEnabled: c.sandbox, UID: 998, EgressAllow: c.resolver})
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("%s: unit differs from what `up` renders:\n%s\nwant:\n%s", c.name, got, want)
		}
		if hasDocker := strings.Contains(got, "DOCKER_HOST=unix:///run/user/998/docker.sock"); hasDocker != c.sandbox {
			t.Errorf("%s: docker directives present = %v, want %v", c.name, hasDocker, c.sandbox)
		}
		if hasAllow := strings.Contains(got, "IPAddressAllow=169.254.169.254/32"); hasAllow != (len(c.resolver) > 0) {
			t.Errorf("%s: resolver exception present = %v, want %v", c.name, hasAllow, len(c.resolver) > 0)
		}
	}
}

// A parameter that cannot be read is an error, never a default: a rewrite on a
// guess could drop the sandbox of a host, or point the unit at the wrong uid.
func TestDesiredGatewayUnitRefusesToGuess(t *testing.T) {
	resolv := resolvConf(t, "nameserver 127.0.0.53\n")
	st := &state.File{}
	if _, err := DesiredGatewayUnit(context.Background(), serviceAccounts(), nil, resolv, nil); err == nil || !strings.Contains(err.Error(), "no state file") {
		t.Fatalf("no state: err = %v", err)
	}
	missing := account.Client{Runner: exectest.NewFake(), Lookup: func(name string) (*user.User, error) { return nil, user.UnknownUserError(name) }}
	if _, err := DesiredGatewayUnit(context.Background(), missing, st, resolv, nil); err == nil || !strings.Contains(err.Error(), "is missing") {
		t.Fatalf("no service account: err = %v", err)
	}
	broken := account.Client{Runner: exectest.NewFake(), Lookup: func(string) (*user.User, error) { return nil, errors.New("nss unavailable") }}
	if _, err := DesiredGatewayUnit(context.Background(), broken, st, resolv, nil); err == nil || !strings.Contains(err.Error(), "nss unavailable") {
		t.Fatalf("unreadable account: err = %v", err)
	}
}
