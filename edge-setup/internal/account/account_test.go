package account

import (
	"context"
	"os/user"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

// lookup answers like user.Lookup for the names it knows.
func lookup(known map[string]user.User) func(string) (*user.User, error) {
	return func(name string) (*user.User, error) {
		if u, ok := known[name]; ok {
			return &u, nil
		}
		return nil, user.UnknownUserError(name)
	}
}

func client(t *testing.T, known map[string]user.User) (Client, *exectest.Fake) {
	t.Helper()
	f := exectest.NewFake()
	return Client{Runner: f, Lookup: lookup(known)}, f
}

// The service account must never be able to escalate: the whole sandbox
// story rests on `hermes` having neither sudo nor docker. This is the check
// that enforces it, and it must name the group it refused.
func TestRequireUnprivilegedRefusesSudoAndDocker(t *testing.T) {
	for _, groups := range []string{"hermes sudo", "hermes docker", "docker", "sudo hermes users"} {
		c, f := client(t, nil)
		f.On("/usr/bin/id -nG hermes", exec.Result{Stdout: groups + "\n"})
		err := c.RequireUnprivileged(context.Background(), "hermes")
		if err == nil {
			t.Fatalf("groups %q accepted", groups)
		}
		if !strings.Contains(err.Error(), "escalate") {
			t.Errorf("groups %q: unhelpful refusal %q", groups, err)
		}
	}
	c, f := client(t, nil)
	f.On("/usr/bin/id -nG hermes", exec.Result{Stdout: "hermes users\n"})
	if err := c.RequireUnprivileged(context.Background(), "hermes"); err != nil {
		t.Fatalf("an unprivileged account was refused: %v", err)
	}
	// A group whose name merely contains "sudo" is not the sudo group.
	c, f = client(t, nil)
	f.On("/usr/bin/id -nG hermes", exec.Result{Stdout: "hermes pseudo sudoers\n"})
	if err := c.RequireUnprivileged(context.Background(), "hermes"); err != nil {
		t.Fatalf("substring match refused a valid account: %v", err)
	}
}

// The service account is created locked, without a shell: a system account
// with nologin. An existing account is never re-created or modified.
func TestEnsureSystemUserCreatesALockedNologinAccountOnce(t *testing.T) {
	c, f := client(t, nil)
	f.OnPrefix("/usr/sbin/useradd", exec.Result{})
	f.On("/usr/bin/getent passwd hermes", exec.Result{Stdout: "hermes:x:997:997::/srv/hermes:/usr/sbin/nologin\n"})
	if _, err := c.EnsureSystemUser(context.Background(), "hermes", "/srv/hermes"); err != nil {
		t.Fatal(err)
	}
	want := "/usr/sbin/useradd --system --user-group --shell /usr/sbin/nologin --home-dir /srv/hermes --create-home hermes"
	if !f.Ran(want) {
		t.Fatalf("missing %q; ran %v", want, f.Commands())
	}

	// Existing account: nothing is executed.
	existing := map[string]user.User{"hermes": {Uid: "997", Gid: "997", Username: "hermes"}}
	c2, f2 := client(t, existing)
	f2.On("/usr/bin/getent passwd hermes", exec.Result{Stdout: "hermes:x:997:997::/srv/hermes:/usr/sbin/nologin\n"})
	if _, err := c2.EnsureSystemUser(context.Background(), "hermes", "/srv/hermes"); err != nil {
		t.Fatal(err)
	}
	for _, cmd := range f2.Commands() {
		if strings.Contains(cmd, "useradd") {
			t.Fatalf("an existing account was re-created: %v", f2.Commands())
		}
	}
}

// The admin account is key-only: useradd then `usermod --lock`, so no
// password can ever authenticate it.
func TestEnsureLoginUserLocksThePassword(t *testing.T) {
	c, f := client(t, nil)
	f.OnPrefix("/usr/sbin/useradd", exec.Result{})
	f.OnPrefix("/usr/sbin/usermod", exec.Result{})
	f.On("/usr/bin/getent passwd hermes-admin", exec.Result{Stdout: "hermes-admin:x:1000:1000::/home/hermes-admin:/bin/bash\n"})
	if _, err := c.EnsureLoginUser(context.Background(), "hermes-admin"); err != nil {
		t.Fatal(err)
	}
	if !f.Ran("/usr/sbin/usermod --lock hermes-admin") {
		t.Fatalf("the password was not locked; ran %v", f.Commands())
	}
}

// AsUser is how every command runs under the service account. A secret must
// never be placed in the environment it builds: the callers pass it on
// stdin, and this shape is what makes that possible.
func TestAsUserBuildsARunuserPrefixWithoutASecret(t *testing.T) {
	cmd := AsUser("hermes", []string{"HOME=/srv/hermes", "PATH=/usr/bin"}, "/opt/venv/bin/hermes", "auth", "add", "anthropic")
	got := cmd.String()
	want := "/usr/sbin/runuser -u hermes -- /usr/bin/env HOME=/srv/hermes PATH=/usr/bin /opt/venv/bin/hermes auth add anthropic"
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if len(cmd.Stdin) != 0 {
		t.Fatal("AsUser must not preset stdin: the caller owns the secret")
	}
}

func TestInGroupIsExact(t *testing.T) {
	groups := []string{"hermes", "sudoers", "dockerroot"}
	for _, g := range []string{"sudo", "docker", ""} {
		if InGroup(groups, g) {
			t.Errorf("%q matched %v", g, groups)
		}
	}
	if !InGroup(groups, "hermes") {
		t.Error("exact membership not detected")
	}
}
