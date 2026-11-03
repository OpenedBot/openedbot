package operator

import (
	"slices"
	"strings"
	"testing"
)

// The login streams through a pipe: without PYTHONUNBUFFERED the CLI holds
// the device URL and code in its stdout buffer until exit, and the session
// stays "starting" until it expires (seen on a Debian 13 host).
func TestHostLoginSpecStreamsUnbuffered(t *testing.T) {
	spec := hostLoginSpec("openai-codex")
	if spec.Path != "/usr/sbin/runuser" || !slices.Equal(spec.Args[:3], []string{"-u", "hermes", "--"}) {
		t.Fatalf("login must run through runuser as the service user, got %s %q", spec.Path, spec.Args)
	}
	i := slices.Index(spec.Args, "/usr/bin/env")
	j := slices.Index(spec.Args, "/usr/local/lib/hermes-agent/venv/bin/hermes")
	if i < 0 || j < i {
		t.Fatalf("expected env … hermes, got %q", spec.Args)
	}
	env := spec.Args[i+1 : j]
	for _, want := range []string{"PYTHONUNBUFFERED=1", "HERMES_HOME=/srv/hermes/data", "HOME=/srv/hermes/data/home"} {
		if !slices.Contains(env, want) {
			t.Errorf("missing %s in the CLI environment %q", want, env)
		}
	}
	if got := strings.Join(spec.Args[j+1:], " "); got != "auth add openai-codex --no-browser" {
		t.Errorf("unexpected CLI arguments %q", got)
	}
}
