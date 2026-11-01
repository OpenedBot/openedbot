//go:build linux || darwin

package operator

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

// A program that ignores SIGTERM in its whole group, like upstream's
// interpreter under runuser: cancelling must still end it.
var termIgnoringSpec = exec.Cmd{Path: "/bin/sh", Args: []string{"-c", "trap '' TERM; sleep 30 & wait"}}

func waitEnds(t *testing.T, flow OAuthFlow, within time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		_ = flow.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(within):
		t.Fatalf("the authorization program outlived its cancellation by %s", within)
	}
}

func TestMCPOAuthKillEndsAProgramThatIgnoresSIGTERM(t *testing.T) {
	previous := mcpOAuthKillGrace
	mcpOAuthKillGrace = 100 * time.Millisecond
	t.Cleanup(func() { mcpOAuthKillGrace = previous })

	flow, err := startMCPOAuthWithSpec(context.Background(), "linear", "dev", "https://openedbot.example/cb", termIgnoringSpec, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	flow.Kill()
	waitEnds(t, flow, 3*time.Second)
}

func TestMCPOAuthCancelledContextEndsTheWholeGroup(t *testing.T) {
	previous := mcpOAuthKillGrace
	mcpOAuthKillGrace = 100 * time.Millisecond
	t.Cleanup(func() { mcpOAuthKillGrace = previous })

	ctx, cancel := context.WithCancel(context.Background())
	flow, err := startMCPOAuthWithSpec(ctx, "linear", "", "https://openedbot.example/cb", termIgnoringSpec, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	cancel()
	waitEnds(t, flow, 3*time.Second)
}

// The lab host case: the hardened operator cannot signal the interpreter
// (no CAP_KILL, another uid), so signals change nothing. Closing stdin, the
// program's "the operator gave up", must end it on its own.
func TestMCPOAuthKillClosesStdinWhenSignalsCannotReach(t *testing.T) {
	previous := mcpOAuthKillGrace
	mcpOAuthKillGrace = time.Hour
	t.Cleanup(func() { mcpOAuthKillGrace = previous })

	// Reads the request line, then waits for a callback line until EOF.
	spec := exec.Cmd{Path: "/bin/sh", Args: []string{"-c", "trap '' TERM; read request; while read callback; do :; done"}}
	flow, err := startMCPOAuthWithSpec(context.Background(), "linear", "dev", "https://openedbot.example/cb", spec, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	flow.Kill()
	waitEnds(t, flow, 3*time.Second)
}
