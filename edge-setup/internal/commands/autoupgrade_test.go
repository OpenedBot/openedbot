package commands

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
)

// fakeHost is what an automatic pass sees and does, recorded.
type fakeHost struct {
	now         time.Time
	manifest    map[string]string
	manifestErr error
	current     []byte
	installed   string
	release     []byte
	version     string
	// signed is the version the manifest signature was checked for; empty
	// stands for version (an honest release).
	signed     string
	runs       int
	busy       string
	proveErr   []error
	finishErr  error
	installErr []error

	downloads        int
	downloadVersions []string
	kept             [][]byte
	installs         [][]byte
	finishes         []string
	rollbacks        []bool
	proofs           []string
}

func newFakeHost(t *testing.T) (*fakeHost, autoUpgrader) {
	h := &fakeHost{
		now:       time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC),
		current:   candidateTestBytes("v0.3.0"),
		installed: "v0.3.0",
		release:   candidateTestBytes("v0.3.1"),
		version:   "v0.3.1",
	}
	h.manifest = map[string]string{"hermes-setup_linux_amd64": selfupdate.Digest(h.release)}
	u := autoUpgrader{
		now:        func() time.Time { return h.now },
		logf:       func(string, ...any) {},
		recordPath: filepath.Join(t.TempDir(), "auto-upgrade.json"),
		asset:      "hermes-setup_linux_amd64",
		busy:       func() string { return h.busy },
		activeRuns: func() int { return h.runs },
		manifest: func(context.Context) (map[string]string, string, error) {
			signed := h.signed
			if signed == "" {
				signed = h.version
			}
			return h.manifest, signed, h.manifestErr
		},
		download: func(_ context.Context, version string) ([]byte, string, error) {
			h.downloads++
			h.downloadVersions = append(h.downloadVersions, version)
			return h.release, selfupdate.Digest(h.release), nil
		},
		installed: func(context.Context) ([]byte, string, error) { return h.current, h.installed, nil },
		version:   func(context.Context, []byte) (string, error) { return h.version, nil },
		keep: func(data []byte) error {
			h.kept = append(h.kept, data)
			return nil
		},
		install: func(data []byte) error {
			h.installs = append(h.installs, data)
			if len(h.installErr) > 0 {
				err := h.installErr[0]
				h.installErr = h.installErr[1:]
				return err
			}
			return nil
		},
		finish: func(_ context.Context, previous string, rollback bool) error {
			h.finishes = append(h.finishes, previous)
			h.rollbacks = append(h.rollbacks, rollback)
			return h.finishErr
		},
		watch: func(context.Context) []watchedLink {
			return []watchedLink{{Unit: "hermes-connector", StateDir: "/var/lib/hermes-connector"}}
		},
		prove: func(_ context.Context, _ time.Time, version string, _ []watchedLink) error {
			h.proofs = append(h.proofs, version)
			if len(h.proveErr) > 0 {
				err := h.proveErr[0]
				h.proveErr = h.proveErr[1:]
				return err
			}
			return nil
		},
	}
	return h, u
}

// Nothing to install is decided on the manifest alone: the binary is never
// downloaded, and an unreadable release is not a failed unit.
func TestAutoUpgradeDecidesOnTheManifestBeforeDownloading(t *testing.T) {
	h, u := newFakeHost(t)
	h.manifestErr = errors.New("SHA256SUMS: HTTP 404")
	if code, rec := u.run(context.Background()); code != cli.ExitOK || rec.Outcome != autoOutcomeBlocked || !strings.Contains(rec.Detail, "HTTP 404") {
		t.Fatalf("unreadable release: code=%d record=%+v", code, rec)
	}
	h.manifestErr = nil
	h.current = h.release
	if code, rec := u.run(context.Background()); code != cli.ExitOK || rec.Outcome != autoOutcomeUpToDate {
		t.Fatalf("up to date: code=%d record=%+v", code, rec)
	}
	h.busy = "a transaction is active"
	if _, rec := u.run(context.Background()); rec.Outcome != autoOutcomeDeferred {
		t.Fatalf("transaction: %+v", rec)
	}
	if h.downloads != 0 || len(h.installs) != 0 {
		t.Fatalf("downloads=%d installs=%d, want none", h.downloads, len(h.installs))
	}
}

// A release cut at or before v0.4.0 lists only the pre-rename asset name;
// the pass must still see a candidate through legacyAsset instead of
// reporting the release as unpublished (OHB-87 rename).
func TestAutoUpgradeFallsBackToLegacyAssetName(t *testing.T) {
	h, u := newFakeHost(t)
	u.asset = "edge-setup_linux_amd64"
	u.legacyAsset = "hermes-setup_linux_amd64"
	h.manifest = map[string]string{"hermes-setup_linux_amd64": selfupdate.Digest(h.release)}
	if code, rec := u.run(context.Background()); code != cli.ExitOK || rec.Outcome != autoOutcomeUpgraded {
		t.Fatalf("legacy-named manifest: code=%d %+v", code, rec)
	}
	// Without the fallback name, an old manifest is reported as unpublished.
	h2, u2 := newFakeHost(t)
	u2.asset = "edge-setup_linux_amd64"
	h2.manifest = map[string]string{"hermes-setup_linux_amd64": selfupdate.Digest(h2.release)}
	if _, rec := u2.run(context.Background()); rec.Outcome != autoOutcomeBlocked {
		t.Fatalf("expected blocked without legacyAsset: %+v", rec)
	}
}

// Runs in progress hold a release back for at most a day.
func TestAutoUpgradeDefersRunsInProgressForADayAtMost(t *testing.T) {
	h, u := newFakeHost(t)
	h.runs = 2
	if _, rec := u.run(context.Background()); rec.Outcome != autoOutcomeDeferred || rec.DeferredSince == "" {
		t.Fatalf("first deferral: %+v", rec)
	}
	h.now = h.now.Add(23 * time.Hour)
	if _, rec := u.run(context.Background()); rec.Outcome != autoOutcomeDeferred || len(h.installs) != 0 {
		t.Fatalf("within a day: %+v installs=%d", rec, len(h.installs))
	}
	h.now = h.now.Add(2 * time.Hour)
	if code, rec := u.run(context.Background()); code != cli.ExitOK || rec.Outcome != autoOutcomeUpgraded || rec.DeferredSince != "" {
		t.Fatalf("after a day: code=%d %+v", code, rec)
	}
}

// Only a newer vX.Y.Z replaces the installed binary; a development build is
// left alone, and a release judged once is not downloaded again.
func TestAutoUpgradeInstallsOnlyANewerStableRelease(t *testing.T) {
	for _, c := range []struct{ installed, candidate string }{
		{"v0.3.1", "v0.3.1"},
		{"v0.4.0", "v0.3.1"},
		{"v0.3.0", "v0.3.1-rc1"},
		{"dev", "v0.3.1"},
		{"v0.3.0-1-g44c185a-dirty", "v0.3.0"},
	} {
		h, u := newFakeHost(t)
		h.installed, h.version = c.installed, c.candidate
		if code, rec := u.run(context.Background()); code != cli.ExitOK || rec.Outcome != autoOutcomeNotNewer || rec.NotNewerSum == "" {
			t.Fatalf("%s -> %s: code=%d %+v", c.installed, c.candidate, code, rec)
		}
		if _, rec := u.run(context.Background()); rec.Outcome != autoOutcomeNotNewer || h.downloads != 1 {
			t.Fatalf("%s -> %s: second pass downloaded again (%d) %+v", c.installed, c.candidate, h.downloads, rec)
		}
		if len(h.installs) != 0 {
			t.Fatalf("%s -> %s installed", c.installed, c.candidate)
		}
	}
}

func TestAutoUpgradeInstallsKeepsThePreviousAndProvesTheNewBinary(t *testing.T) {
	h, u := newFakeHost(t)
	code, rec := u.run(context.Background())
	if code != cli.ExitOK || rec.Outcome != autoOutcomeUpgraded || rec.Installed != "v0.3.1" {
		t.Fatalf("code=%d %+v", code, rec)
	}
	if len(h.kept) != 1 || string(h.kept[0]) != string(h.current) {
		t.Fatalf("previous binary not kept: %q", h.kept)
	}
	if len(h.installs) != 1 || string(h.installs[0]) != string(h.release) {
		t.Fatalf("installs: %q", h.installs)
	}
	if strings.Join(h.finishes, ",") != "v0.3.0" || strings.Join(h.proofs, ",") != "v0.3.1" {
		t.Fatalf("finishes=%v proofs=%v", h.finishes, h.proofs)
	}
	if len(h.rollbacks) != 1 || h.rollbacks[0] {
		t.Fatalf("rollback modes=%v, want [false]", h.rollbacks)
	}
}

// A new binary that does not bring the link back is replaced by the previous
// one, proven in turn, and never retried.
func TestAutoUpgradeRollsBackAReleaseThatDoesNotProveItself(t *testing.T) {
	h, u := newFakeHost(t)
	h.proveErr = []error{errors.New("hermes-connector.service was not admitted by openedbot again within 2m0s")}
	code, rec := u.run(context.Background())
	if code != cli.ExitFailure || rec.Outcome != autoOutcomeRolledBack || rec.FailedVersion != "v0.3.1" || rec.FailedSum != selfupdate.Digest(h.release) {
		t.Fatalf("code=%d %+v", code, rec)
	}
	if len(h.installs) != 2 || string(h.installs[1]) != string(h.current) {
		t.Fatalf("the previous binary was not reinstalled: %d installs", len(h.installs))
	}
	if strings.Join(h.finishes, ",") != "v0.3.0,v0.3.1" || strings.Join(h.proofs, ",") != "v0.3.1,v0.3.0" {
		t.Fatalf("finishes=%v proofs=%v", h.finishes, h.proofs)
	}
	// The restored binary re-renders its units as a rollback, so it prints
	// "rolled back", not "upgraded".
	if len(h.rollbacks) != 2 || h.rollbacks[0] || !h.rollbacks[1] {
		t.Fatalf("rollback modes=%v, want [false true]", h.rollbacks)
	}
	if _, warning := autoUpgradeDoctor(rec); !strings.Contains(warning, "v0.3.1 rejected") {
		t.Fatalf("doctor warning: %q", warning)
	}
	h.downloads = 0
	code, rec = u.run(context.Background())
	if code != cli.ExitOK || rec.Outcome != autoOutcomeHeldBack || h.downloads != 0 {
		t.Fatalf("second pass: code=%d downloads=%d %+v", code, h.downloads, rec)
	}
	if _, warning := autoUpgradeDoctor(rec); !strings.Contains(warning, "was rolled back") {
		t.Fatalf("doctor forgot the rejected release: %q", warning)
	}
}

func TestAutoUpgradeReportsARollbackThatFails(t *testing.T) {
	h, u := newFakeHost(t)
	h.finishErr = errors.New("exit status 1")
	h.proveErr = []error{nil}
	code, rec := u.run(context.Background())
	if code != cli.ExitFailure || rec.Outcome != autoOutcomeRollbackFailed {
		t.Fatalf("code=%d %+v", code, rec)
	}
	if problem, _ := autoUpgradeDoctor(rec); !strings.Contains(problem, "could not restore the previous binary") {
		t.Fatalf("doctor problem: %q", problem)
	}
}

func TestLinkAdmittedMarkerRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, _, ok := linkAdmitted(dir); ok {
		t.Fatal("no marker, no admission")
	}
	at := time.Date(2026, 9, 14, 12, 0, 0, 123456789, time.UTC)
	if err := writeLinkAdmitted(dir, "hermes-setup/v0.3.1", at); err != nil {
		t.Fatal(err)
	}
	got, agent, ok := linkAdmitted(dir)
	if !ok || !got.Equal(at) || agent != "hermes-setup/v0.3.1" {
		t.Fatalf("got %s %q %v", got, agent, ok)
	}
}

// A v0.4.0 binary proves its automatic upgrade to this release by reading
// "hermes-setup/<version>" in the marker, while the wire hello says
// edge-setup/<version>: the marker keeps the pre-rename spelling (OHB-87)
// and proveUpgrade accepts both, for the right version only.
func TestAdmissionMarkerKeepsThePreRenameSpelling(t *testing.T) {
	if got := admittedAgentMarker("edge-setup/v0.5.0"); got != "hermes-setup/v0.5.0" {
		t.Fatalf("marker spelling: %q", got)
	}
	if got := admittedAgentMarker("hermes-setup/v0.4.0"); got != "hermes-setup/v0.4.0" {
		t.Fatalf("legacy agent rewritten: %q", got)
	}
	for got, ok := range map[string]bool{
		"edge-setup/v0.5.0":   true,
		"hermes-setup/v0.5.0": true,
		"edge-setup/v0.4.0":   false,
		"hermes-setup/v0.4.0": false,
		"":                    false,
	} {
		if admittedAs(got, "edge-setup/v0.5.0") != ok {
			t.Errorf("admittedAs(%q) != %v", got, ok)
		}
	}
}

func TestUpgradeLockRefusesASecondHolder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.lock")
	unlock, err := lockUpgrade(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockUpgrade(path); err == nil {
		t.Fatal("a second upgrade took the lock")
	}
	unlock()
	again, err := lockUpgrade(path)
	if err != nil {
		t.Fatalf("lock not released: %v", err)
	}
	again()
}

// A rejected release is left alone for a day, then tried once more: a full
// disk or a network cut during the proof must not condemn it for good.
func TestAutoUpgradeRetriesARejectedReleaseAfterItsHold(t *testing.T) {
	h, u := newFakeHost(t)
	h.proveErr = []error{errors.New("was not admitted by openedbot again within 2m0s")}
	if code, rec := u.run(context.Background()); code != cli.ExitFailure || rec.Outcome != autoOutcomeRolledBack {
		t.Fatalf("first pass: code=%d %+v", code, rec)
	}
	h.downloads = 0
	h.now = h.now.Add(autoUpgradeHoldBack - time.Minute)
	if code, rec := u.run(context.Background()); code != cli.ExitOK || rec.Outcome != autoOutcomeHeldBack || h.downloads != 0 {
		t.Fatalf("inside the hold: code=%d downloads=%d %+v", code, h.downloads, rec)
	}
	h.now = h.now.Add(2 * time.Minute)
	code, rec := u.run(context.Background())
	if code != cli.ExitOK || rec.Outcome != autoOutcomeUpgraded {
		t.Fatalf("after the hold: code=%d %+v", code, rec)
	}
	if h.downloads != 1 {
		t.Fatalf("the release was not tried again: downloads=%d", h.downloads)
	}
	if rec.FailedSum != "" || rec.FailedAt != "" {
		t.Fatalf("a successful upgrade must clear the rejection: %+v", rec)
	}
}

// A record written by an older build carries no timestamp: it is stamped on
// sight, so the hold ends a day later instead of lasting forever.
func TestAutoUpgradeStampsALegacyRejectionInsteadOfHoldingItForever(t *testing.T) {
	h, u := newFakeHost(t)
	legacy := autoUpgradeRecord{Schema: 1, FailedSum: selfupdate.Digest(h.release), FailedVersion: "v0.3.1"}
	if err := saveAutoUpgradeRecord(u.recordPath, legacy); err != nil {
		t.Fatal(err)
	}
	code, rec := u.run(context.Background())
	if code != cli.ExitOK || rec.Outcome != autoOutcomeHeldBack {
		t.Fatalf("code=%d %+v", code, rec)
	}
	if rec.FailedAt == "" {
		t.Fatal("the rejection was not stamped, so it would never expire")
	}
	h.now = h.now.Add(autoUpgradeHoldBack + time.Minute)
	if code, rec := u.run(context.Background()); code != cli.ExitOK || rec.Outcome != autoOutcomeUpgraded {
		t.Fatalf("after the hold: code=%d %+v", code, rec)
	}
}

// doctor warns about a disabled timer with the exact command that enables it,
// and says nothing once it is enabled.
func TestDoctorWarnsWhileAutoUpgradeIsDisabled(t *testing.T) {
	warning := autoUpgradeOffWarning(autoUpgradeSummary{})
	for _, want := range []string{"auto-upgrade is disabled", "`sudo edge-setup auto-upgrade enable --yes`", "`sudo edge-setup upgrade --yes`"} {
		if !strings.Contains(warning, want) {
			t.Fatalf("%q does not contain %q", warning, want)
		}
	}
	if warning := autoUpgradeOffWarning(autoUpgradeSummary{Enabled: true, NextRun: "Tue 2026-10-06 18:00:00 UTC"}); warning != "" {
		t.Fatalf("an enabled timer still warns: %q", warning)
	}
}

// The end of a successful `up` or `link` prints one hint when the timer is
// not installed, and only reads systemd to decide it.
func TestUpAndLinkHintAutoUpgradeWhenDisabled(t *testing.T) {
	previous := runner
	fake := exectest.NewFake()
	runner = fake
	defer func() { runner = previous }()
	var out bytes.Buffer
	printAutoUpgradeHint(cli.Env{Stdout: &out})
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "hint ! auto-upgrade is disabled") || !strings.Contains(lines[0], autoUpgradeEnableCommand) {
		t.Fatalf("hint: %q", out.String())
	}
	for _, call := range fake.Commands() {
		if strings.Contains(call, "enable") || strings.Contains(call, "daemon-reload") {
			t.Fatalf("the hint mutated systemd: %s", call)
		}
	}
}

// The binary of the automatic pass is fetched from the very version whose
// signature was checked, and must claim that version: a SHA256SUMS signed on
// one tag never installs a binary of another (held back, nothing changed).
func TestAutoUpgradeRefusesAVersionMismatch(t *testing.T) {
	h, u := newFakeHost(t)
	h.signed, h.version = "v0.3.1", "v0.3.2"
	code, rec := u.run(context.Background())
	if code != cli.ExitFailure || rec.Outcome != autoOutcomeFailed || !strings.Contains(rec.Detail, "version mismatch") {
		t.Fatalf("mismatch: code=%d %+v", code, rec)
	}
	if len(h.installs) != 0 || len(h.kept) != 0 {
		t.Fatalf("a mismatched release was installed: installs=%d kept=%d", len(h.installs), len(h.kept))
	}
	if strings.Join(h.downloadVersions, ",") != "v0.3.1" {
		t.Fatalf("download asked for %v, want the signed v0.3.1", h.downloadVersions)
	}
	if _, rec := u.run(context.Background()); rec.Outcome != autoOutcomeHeldBack {
		t.Fatalf("second pass: %+v", rec)
	}
}

// The automatic pass never downgrades and never reinstalls the same version,
// whatever the release origin serves as LATEST.
func TestAutoUpgradeNeverDowngrades(t *testing.T) {
	for _, c := range []struct{ installed, latest string }{
		{"v0.0.3", "v0.0.2"},
		{"v0.0.3", "v0.0.3"},
		{"v1.0.0", "v0.9.9"},
	} {
		h, u := newFakeHost(t)
		h.installed, h.version = c.installed, c.latest
		if _, rec := u.run(context.Background()); rec.Outcome != autoOutcomeNotNewer || len(h.installs) != 0 {
			t.Fatalf("%s -> %s: %+v installs=%d", c.installed, c.latest, rec, len(h.installs))
		}
	}
}
