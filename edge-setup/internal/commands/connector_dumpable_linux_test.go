//go:build linux

package commands

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"golang.org/x/sys/unix"
)

// dumpableChildEnv makes a re-executed copy of this test binary play the
// connector instead of running the suite: PR_SET_DUMPABLE is process wide and
// cannot be raised again, so the check must not touch the process that runs
// the other tests.
const dumpableChildEnv = "EDGE_SETUP_TEST_CONNECTOR_DUMPABLE_CHILD"

// The connector shares the gateway's uid. The kernel lets every process of
// that uid open /proc/<pid>/{root,cwd,fd,environ,mem} of a dumpable process,
// which walks past the gateway's InaccessiblePaths= into the connector's own
// mount namespace, where its credentials are. A non-dumpable process refuses
// all of them, on any systemd version (PrivatePIDs= needs 257). Every connector
// instance, default or named, starts through `internal connector`.
func TestInternalConnectorStartsNonDumpable(t *testing.T) {
	if os.Getenv(dumpableChildEnv) == "1" {
		connectorChild()
		return
	}
	// An empty environment: no CREDENTIALS_DIRECTORY, so the daemon refuses
	// to start right after the hook, without reading or dialling anything.
	cmd := exec.Command(os.Args[0], "-test.run=^TestInternalConnectorStartsNonDumpable$")
	cmd.Env = []string{dumpableChildEnv + "=1"}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
	var before, after, code int
	found := false
	for _, line := range strings.Split(string(out), "\n") {
		if _, err := fmt.Sscanf(line, "dumpable before=%d after=%d code=%d", &before, &after, &code); err == nil {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("the child did not report its dumpable flag:\n%s", out)
	}
	if before != 1 {
		t.Fatalf("PR_GET_DUMPABLE=%d before `internal connector`: a fresh process must be dumpable, or this proves nothing", before)
	}
	if code != cli.ExitRefused {
		t.Fatalf("`internal connector` exited %d, want %d (refused: no credentials directory)", code, cli.ExitRefused)
	}
	if after != 0 {
		t.Errorf("PR_GET_DUMPABLE=%d after `internal connector`, want 0: a process of the gateway's uid could open /proc/<connector pid>/{root,cwd,fd,environ,mem}", after)
	}
}

// connectorChild runs the real entry point of every connector instance and
// reports the dumpable flag around it.
func connectorChild() {
	before, _ := unix.PrctlRetInt(unix.PR_GET_DUMPABLE, 0, 0, 0, 0)
	code := runInternal(cli.Env{Version: "test", Stdout: io.Discard, Stderr: io.Discard}, []string{"connector"})
	after, _ := unix.PrctlRetInt(unix.PR_GET_DUMPABLE, 0, 0, 0, 0)
	fmt.Printf("dumpable before=%d after=%d code=%d\n", before, after, code)
	os.Exit(0)
}
