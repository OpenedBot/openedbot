package commands

import (
	"flag"
	"io"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

func TestUpUsesPositiveFeatureFlagsAndRejectsRemovedNegatives(t *testing.T) {
	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	o := bindUpFlags(fs)
	if err := fs.Parse([]string{"--sandbox", "--firewall", "--allow-inbound", "443/TCP", "--ssh-hardening"}); err != nil {
		t.Fatal(err)
	}
	got := o.requestedFeatures()
	if !got.Sandbox || !got.Firewall || !got.SSHHardening || len(got.AllowedInbound) != 1 || got.AllowedInbound[0] != "443/tcp" {
		t.Fatalf("positive flags: %+v", got)
	}
	removed := flag.NewFlagSet("up", flag.ContinueOnError)
	removed.SetOutput(io.Discard)
	bindUpFlags(removed)
	if err := removed.Parse([]string{"--no-ssh-hardening"}); err == nil {
		t.Fatal("removed negative flags must be rejected")
	}
}

func TestInternalConnectorDoesNotRequireRoot(t *testing.T) {
	if internalNeedsRoot("connector") {
		t.Fatal("the connector daemon must run as its unprivileged system user")
	}
	for _, entrypoint := range []string{"rollback-access", "proxy-rollback", "operator", "unknown"} {
		if !internalNeedsRoot(entrypoint) {
			t.Errorf("%s unexpectedly bypasses the root check", entrypoint)
		}
	}
}

// After verify-access committed P7, a failed P8 must not make the next `up`
// re-enter the already committed hardening transaction.
func TestResumeAfterCommitSkipsP7OnlyWhenHardenedAndFinalized(t *testing.T) {
	hardened := map[string]state.Phase{"harden": {}}
	if !resumeAfterCommit(hardened, true) {
		t.Fatal("harden recorded + guard finalized must resume at P8")
	}
	if resumeAfterCommit(hardened, false) {
		t.Fatal("armed but not committed: P7 must not be skipped")
	}
	if resumeAfterCommit(map[string]state.Phase{}, true) {
		t.Fatal("finalized guard without a harden record is not resumable")
	}
	if resumeAfterCommit(nil, false) {
		t.Fatal("fresh host must run P7")
	}
}
