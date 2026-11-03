package commands

import (
	"bytes"
	"context"
	"debug/macho"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/selfupdate"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

func candidateTestBytes(payload string) []byte {
	if runtime.GOOS == "darwin" {
		cpu := macho.CpuAmd64
		if runtime.GOARCH == "arm64" {
			cpu = macho.CpuArm64
		}
		return append(machOExecutable64(cpu), []byte(payload)...)
	}
	return append([]byte{0x7f, 'E', 'L', 'F'}, []byte(payload)...)
}

func TestUpgradeProviderSDKNoticeOnlyOffersUpForPinnedExtras(t *testing.T) {
	var out bytes.Buffer
	statuses := []hermes.ProviderSDKStatus{
		{Provider: "anthropic", Label: "Anthropic", Extra: "anthropic", Installed: false},
		{Provider: "bedrock", Label: "AWS Bedrock", Extra: "bedrock", Installed: false},
		{Provider: "vertex", Label: "Google Vertex AI", Extra: "vertex", Installed: true},
	}
	printProviderSDKUpgradeNotice(&out, statuses)
	want := "  provider SDKs not installed (lazy installs are off; runs on these providers fail): Anthropic [anthropic], AWS Bedrock [bedrock]\n" +
		"  run \"sudo edge-setup up\" to install: Anthropic\n"
	if out.String() != want {
		t.Fatalf("notice = %q, want %q (extras: %v)", out.String(), want, pins.HermesExtras)
	}
}

func writeTemp(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// testDeployKey is a fixed deployment secret for the tag tests.
var testDeployKey = func() []byte {
	k, err := parseDeployKey(strings.Repeat("0123456789abcdef", 4))
	if err != nil {
		panic(err)
	}
	return k
}()

func TestNormalizeHex(t *testing.T) {
	upper := strings.Repeat("AB", 32)
	got, err := normalizeHex(" "+upper+"\n", "--tag")
	if err != nil || got != strings.ToLower(upper) {
		t.Fatalf("got %q err=%v", got, err)
	}
	for _, bad := range []string{"", "abc", strings.Repeat("g", 64), strings.Repeat("a", 63), strings.Repeat("a", 65)} {
		if _, err := normalizeHex(bad, "--tag"); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// The tag is what `make deploy` computes with openssl: the frozen vector was
// produced by `printf 'hermes-setup upgrade v1\n%s\n' SUM | openssl dgst
// -sha256 -mac HMAC -macopt hexkey:KEY`; when openssl is on PATH the test
// recomputes it live so the Makefile and the Go side cannot drift apart.
func TestUpgradeTagMatchesOpenSSL(t *testing.T) {
	sum := strings.Repeat("a", 64)
	const frozen = "1c0300b49f4ddce34af395d11020a03481eaf2ae49b762255f4d8c1eb8e886f7"
	if got := upgradeTag(testDeployKey, sum); got != frozen {
		t.Fatalf("tag %s, want frozen %s", got, frozen)
	}
	if !upgradeTagMatches(testDeployKey, sum, strings.ToUpper(frozen)) || upgradeTagMatches(testDeployKey, sum, strings.Repeat("0", 64)) || upgradeTagMatches(testDeployKey, sum, "zz") {
		t.Fatal("tag comparison")
	}
	if _, err := osexec.LookPath("openssl"); err != nil {
		t.Log("openssl absent: frozen vector only")
		return
	}
	cmd := osexec.Command("openssl", "dgst", "-sha256", "-mac", "HMAC", "-macopt", "hexkey:"+strings.Repeat("0123456789abcdef", 4))
	cmd.Stdin = strings.NewReader(upgradeTagPrefix + sum + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 || fields[len(fields)-1] != frozen {
		t.Fatalf("openssl computed %q", strings.TrimSpace(string(out)))
	}
}

func TestUpgradeInstallRefusesMismatchAndWritesNothing(t *testing.T) {
	dir := t.TempDir()
	src := writeTemp(t, dir, "candidate", candidateTestBytes("v2"))
	installed := filepath.Join(dir, "install", "hermes-setup")
	if err := os.MkdirAll(filepath.Dir(installed), 0o755); err != nil {
		t.Fatal(err)
	}
	wrong := strings.Repeat("0", 64)
	_, written, err := upgradeInstall(src, wrong, testDeployKey, fsx.Current(), installed)
	if err == nil || !strings.Contains(err.Error(), "tag mismatch") {
		t.Fatalf("mismatch accepted: written=%v err=%v", written, err)
	}
	// A tag valid under another key is a mismatch too: the key is the proof.
	other, _ := parseDeployKey(strings.Repeat("ff", 32))
	_, written, err = upgradeInstall(src, upgradeTag(other, selfupdate.Digest(candidateTestBytes("v2"))), testDeployKey, fsx.Current(), installed)
	if err == nil || !strings.Contains(err.Error(), "tag mismatch") {
		t.Fatalf("foreign key accepted: written=%v err=%v", written, err)
	}
	if len(written) != 0 {
		t.Fatalf("paths written on refusal: %v", written)
	}
	if _, err := os.Stat(installed); !os.IsNotExist(err) {
		t.Fatalf("installed path exists after refusal: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(installed))
	if len(entries) != 0 {
		t.Fatalf("temp files left behind: %v", entries)
	}
}

func TestUpgradeInstallRefusesNonNativeImage(t *testing.T) {
	dir := t.TempDir()
	data := []byte("#!/bin/sh\necho no\n")
	src := writeTemp(t, dir, "candidate", data)
	installed := filepath.Join(dir, "hermes-setup")
	_, written, err := upgradeInstall(src, upgradeTag(testDeployKey, selfupdate.Digest(data)), testDeployKey, fsx.Current(), installed)
	format := "ELF"
	if runtime.GOOS == "darwin" {
		format = "Mach-O"
	}
	if err == nil || !strings.Contains(err.Error(), format) {
		t.Fatalf("non-native accepted: err=%v", err)
	}
	if len(written) != 0 || fileExists(installed) {
		t.Fatal("non-native candidate was written")
	}
}

func TestUpgradeInstallWritesAndSkipsIdentical(t *testing.T) {
	dir := t.TempDir()
	data := candidateTestBytes("v2")
	src := writeTemp(t, dir, "candidate", data)
	installed := filepath.Join(dir, "hermes-setup")
	other := writeTemp(t, dir, "other", candidateTestBytes("v1"))
	sum := selfupdate.Digest(data)
	norm, err := normalizeHex(strings.ToUpper(upgradeTag(testDeployKey, sum)), "--tag")
	if err != nil {
		t.Fatal(err)
	}
	c, written, err := upgradeInstall(src, norm, testDeployKey, fsx.Current(), installed, other)
	if err != nil {
		t.Fatal(err)
	}
	if c.sum != sum || len(written) != 2 {
		t.Fatalf("sum=%s written=%v", c.sum, written)
	}
	for _, p := range []string{installed, other} {
		got, _ := os.ReadFile(p)
		if !bytes.Equal(got, data) {
			t.Fatalf("%s not replaced", p)
		}
		st, _ := os.Stat(p)
		if st.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode %o", p, st.Mode().Perm())
		}
	}
	// Second run: identical content, nothing rewritten.
	_, written, err = upgradeInstall(src, norm, testDeployKey, fsx.Current(), installed, other)
	if err != nil || len(written) != 0 {
		t.Fatalf("identical content rewritten: %v err=%v", written, err)
	}
}

func TestUpgradeTargets(t *testing.T) {
	const inst = "/usr/local/lib/hermes-setup/hermes-setup"
	cases := []struct {
		running, from string
		want          []string
	}{
		{inst, "", []string{inst}},
		{"/usr/local/lib/hermes-setup/../hermes-setup/hermes-setup", "", []string{inst}},
		{"/usr/local/bin/hermes-setup", "", []string{inst, "/usr/local/bin/hermes-setup"}},
		{"/tmp/hermes-setup_linux_amd64", "/tmp/hermes-setup_linux_amd64", []string{inst}},
		{"/tmp/hermes-setup_linux_amd64", "/tmp/other", []string{inst, "/tmp/hermes-setup_linux_amd64"}},
		{"", "/tmp/x", []string{inst}},
	}
	for _, c := range cases {
		got := upgradeTargets(inst, c.running, c.from)
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("running=%q from=%q: got %v want %v", c.running, c.from, got, c.want)
		}
	}
}

func TestPathCopiesSkipsSymlinksSourceAndTargets(t *testing.T) {
	stat := func(p string) (fsx.Stat, error) {
		switch p {
		case "/usr/local/sbin/hermes-setup":
			return fsx.Stat{Exists: true, Regular: true}, nil
		case "/usr/sbin/hermes-setup":
			return fsx.Stat{Exists: true, Symlink: true}, nil
		case "/usr/local/bin/hermes-setup":
			return fsx.Stat{Exists: true, Regular: true}, nil
		}
		return fsx.Stat{}, nil
	}
	cands := []string{"/usr/local/sbin/hermes-setup", "/usr/sbin/hermes-setup", "/usr/local/bin/hermes-setup", "/opt/none/hermes-setup"}
	got := pathCopies(cands, "/usr/local/bin/hermes-setup", []string{"/usr/local/lib/hermes-setup/hermes-setup"}, stat)
	if strings.Join(got, ",") != "/usr/local/sbin/hermes-setup" {
		t.Fatalf("got %v: regular copies only, never the --from file, a symlink or a missing path", got)
	}
	got = pathCopies(cands, "", []string{"/usr/local/sbin/hermes-setup"}, stat)
	if strings.Join(got, ",") != "/usr/local/bin/hermes-setup" {
		t.Fatalf("already targeted path must not be listed twice: %v", got)
	}
}

func TestEnsurePathLinkAt(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "lib", "hermes-setup")
	link := filepath.Join(dir, "bin", "hermes-setup")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensurePathLinkAt(link, target); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(link); got != target {
		t.Fatalf("link -> %q, want %q", got, target)
	}
	// Repointed when it aims elsewhere.
	os.Remove(link)
	os.Symlink(filepath.Join(dir, "elsewhere"), link)
	if err := ensurePathLinkAt(link, target); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(link); got != target {
		t.Fatalf("stale link not repointed: %q", got)
	}
	// A regular file is the operator's copy: untouched.
	os.Remove(link)
	os.WriteFile(link, []byte("copy"), 0o755)
	if err := ensurePathLinkAt(link, target); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Lstat(link); st.Mode()&os.ModeSymlink != 0 {
		t.Fatal("regular file must not be replaced by a link")
	}
}

// forceAliasAt, unlike ensurePathLinkAt, converts a pre-existing regular
// file into a symlink: this is what ToolAliasPath and ToolLegacyPathLink
// need after the OHB-87 rename, where a regular file is always this tool's
// own stale pre-rename binary, never an operator's copy to preserve.
func TestForceAliasAtReplacesAStaleRegularFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "edge-setup")
	link := filepath.Join(dir, "hermes-setup")
	if err := os.WriteFile(target, []byte("new build"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The pre-rename binary: a real file, exactly what a v0.4.0 host has at
	// ToolAliasPath (/usr/local/lib/hermes-setup/hermes-setup) and at every
	// PATH copy installed by `install … /usr/local/sbin/hermes-setup`.
	if err := os.WriteFile(link, []byte("stale old build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := forceAliasAt(link, target); err != nil {
		t.Fatal(err)
	}
	st, err := os.Lstat(link)
	if err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("stale regular file was not replaced by a symlink: %v %v", st, err)
	}
	if got, _ := os.Readlink(link); got != target {
		t.Fatalf("link -> %q, want %q", got, target)
	}
	// Idempotent: already correct, second call is a no-op that still resolves.
	if err := forceAliasAt(link, target); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(link); got != target {
		t.Fatalf("second call moved the link: %q", got)
	}
	// A stale symlink (aiming elsewhere) is repointed, same as ensurePathLinkAt.
	os.Remove(link)
	os.Symlink(filepath.Join(dir, "elsewhere"), link)
	if err := forceAliasAt(link, target); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(link); got != target {
		t.Fatalf("stale link not repointed: %q", got)
	}
}

// legacyAliasTargets only pairs a legacy name with a canonical copy that
// really exists as a regular file: promotedCanonicalCopies is what creates
// that canonical file when only the legacy name held one (OHB-87 rename).
func TestLegacyAliasTargetsOnlyExistingRegularCopies(t *testing.T) {
	canonical := []string{"/usr/local/sbin/edge-setup", "/usr/sbin/edge-setup", "/usr/local/bin/edge-setup"}
	legacy := []string{"/usr/local/sbin/hermes-setup", "/usr/sbin/hermes-setup", "/usr/local/bin/hermes-setup"}
	stat := func(p string) (fsx.Stat, error) {
		switch p {
		case "/usr/local/sbin/edge-setup":
			return fsx.Stat{Exists: true, Regular: true}, nil
		case "/usr/sbin/edge-setup":
			return fsx.Stat{Exists: true, Symlink: true}, nil // an alias already, not a copy to mirror
		}
		return fsx.Stat{}, nil // /usr/local/bin/edge-setup: never installed here
	}
	got := legacyAliasTargets(canonical, legacy, stat)
	want := map[string]string{"/usr/local/sbin/hermes-setup": "/usr/local/sbin/edge-setup"}
	if len(got) != len(want) || got["/usr/local/sbin/hermes-setup"] != want["/usr/local/sbin/hermes-setup"] {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// Both the canonical filename and its pre-rename alias must execute the
// exact same bytes: the alias is a symlink, never a copy that could drift.
func TestBothNamesRunTheSameBuild(t *testing.T) {
	dir := t.TempDir()
	canonical := filepath.Join(dir, "edge-setup")
	legacy := filepath.Join(dir, "hermes-setup")
	if err := os.WriteFile(canonical, []byte("#!/bin/sh\necho edge-setup v9.9.9\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensurePathLinkAt(legacy, canonical); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{canonical, legacy} {
		out, err := osexec.Command(name).Output()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := strings.TrimSpace(string(out)); got != "edge-setup v9.9.9" {
			t.Fatalf("%s printed %q", name, got)
		}
	}
	// Upgrading the canonical file (same path, new bytes) must be reflected
	// immediately through the alias too: it is a symlink, not a copy.
	if err := os.WriteFile(canonical, []byte("#!/bin/sh\necho edge-setup v9.9.9-1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := osexec.Command(legacy).Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(out)); got != "edge-setup v9.9.9-1" {
		t.Fatalf("alias ran a stale build: %q", got)
	}
}

// promotedCanonicalCopies creates the canonical name only where nothing is
// there yet and the legacy sibling is a regular file (a pre-rename PATH
// copy); an already-targeted or already-populated canonical path, or a
// legacy name that is not a regular file, is never promoted.
func TestPromotedCanonicalCopiesOnlyWhenLegacyIsARegularFile(t *testing.T) {
	canonical := []string{"/usr/local/sbin/edge-setup", "/usr/sbin/edge-setup", "/usr/local/bin/edge-setup", "/opt/edge-setup"}
	legacy := []string{"/usr/local/sbin/hermes-setup", "/usr/sbin/hermes-setup", "/usr/local/bin/hermes-setup", "/opt/hermes-setup"}
	stat := func(p string) (fsx.Stat, error) {
		switch p {
		case "/usr/local/sbin/hermes-setup":
			return fsx.Stat{Exists: true, Regular: true}, nil // promote: nothing at the canonical name yet
		case "/usr/sbin/edge-setup":
			return fsx.Stat{Exists: true, Regular: true}, nil // already there: pathCopies owns it
		case "/usr/sbin/hermes-setup":
			return fsx.Stat{Exists: true, Regular: true}, nil
		case "/usr/local/bin/hermes-setup":
			return fsx.Stat{Exists: true, Symlink: true}, nil // legacy is already an alias, not a copy to promote
		case "/opt/hermes-setup":
			return fsx.Stat{}, nil // nothing at either name
		}
		return fsx.Stat{}, nil
	}
	got := promotedCanonicalCopies(canonical, legacy, []string{"/usr/local/bin/edge-setup"}, stat)
	if strings.Join(got, ",") != "/usr/local/sbin/edge-setup" {
		t.Fatalf("got %v, want only the promoted sbin copy", got)
	}
}

// End to end reproduction of the bug found on the dev VPS after the OHB-87
// rename: a v0.4.0 host has a regular file at the pre-rename PATH copy
// (/usr/local/sbin/hermes-setup, installed by the old bootstrap's `install`)
// and nothing at the canonical name. An upgrade pass must create the
// canonical file with the new bytes and turn the legacy name into a symlink
// to it, not leave the legacy file a stale, never-refreshed copy.
func TestLegacyRegularPathCopyIsPromotedAndAliasedAfterUpgrade(t *testing.T) {
	dir := t.TempDir()
	canonical := filepath.Join(dir, "edge-setup")
	legacy := filepath.Join(dir, "hermes-setup")
	if err := os.WriteFile(legacy, candidateTestBytes("v0.4.0"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Mirrors runUpgrade's target computation: pathCopies finds nothing at
	// the canonical name, promotedCanonicalCopies must add it because the
	// legacy sibling is a regular file.
	var targets []string
	targets = append(targets, pathCopies([]string{canonical}, "", targets, fsx.Lstat)...)
	if len(targets) != 0 {
		t.Fatalf("pathCopies must not invent the canonical copy: %v", targets)
	}
	targets = append(targets, promotedCanonicalCopies([]string{canonical}, []string{legacy}, targets, fsx.Lstat)...)
	if strings.Join(targets, ",") != canonical {
		t.Fatalf("promotedCanonicalCopies did not add the canonical path: %v", targets)
	}

	newBuild := candidateTestBytes("v0.4.1")
	if _, err := selfupdate.Install(newBuild, fsx.Current(), targets...); err != nil {
		t.Fatal(err)
	}

	for link, target := range legacyAliasTargets([]string{canonical}, []string{legacy}, fsx.Lstat) {
		if err := forceAliasAt(link, target); err != nil {
			t.Fatal(err)
		}
	}

	st, err := os.Lstat(legacy)
	if err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("legacy path is still a regular file, not aliased: %v %v", st, err)
	}
	if got, _ := os.Readlink(legacy); got != canonical {
		t.Fatalf("legacy -> %q, want %q", got, canonical)
	}
	got, err := os.ReadFile(canonical)
	if err != nil || string(got) != string(newBuild) {
		t.Fatalf("canonical file does not carry the new build: %v %v", got, err)
	}
	gotViaLegacy, err := os.ReadFile(legacy)
	if err != nil || string(gotViaLegacy) != string(newBuild) {
		t.Fatalf("legacy alias does not resolve to the new build: %v %v", gotViaLegacy, err)
	}
}

// forceAliasAt never removes a regular file while its target is missing or
// only a link: that file may be the only copy of the binary.
func TestForceAliasAtKeepsARegularFileWhoseTargetIsNotOne(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(dir, "hermes-setup")
	target := filepath.Join(dir, "edge-setup")
	if err := os.WriteFile(link, candidateTestBytes("only copy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := forceAliasAt(link, target); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Lstat(link); err != nil || !st.Mode().IsRegular() {
		t.Fatalf("regular file replaced while the target is missing: %v %v", st, err)
	}
	if err := os.Symlink(link, target); err != nil {
		t.Fatal(err)
	}
	if err := forceAliasAt(link, target); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Lstat(link); err != nil || !st.Mode().IsRegular() {
		t.Fatalf("regular file replaced while the target is a link: %v %v", st, err)
	}
}

// A v0.4.0 host upgrading itself to this release (OHB-87 bridge): the old
// binary writes the new bytes to the pre-rename name and runs the finish step
// from there, so the canonical name does not exist yet. The finish keeps that
// file, makes every name resolve to it, survives a rollback by the old
// binary, and flips to the canonical layout on the next upgrade run by this
// code.
func TestPreRenameDrivenUpgradeKeepsTheOnlyCopyThenFlips(t *testing.T) {
	dir := t.TempDir()
	lib, bin := filepath.Join(dir, "lib"), filepath.Join(dir, "bin")
	for _, d := range []string{lib, bin} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	canonical, alias := filepath.Join(lib, "edge-setup"), filepath.Join(lib, "hermes-setup")
	pathLink, legacyPathLink := filepath.Join(bin, "edge-setup"), filepath.Join(bin, "hermes-setup")
	resolvesTo := func(want []byte, names ...string) {
		t.Helper()
		for _, name := range names {
			if got, err := os.ReadFile(name); err != nil || string(got) != string(want) {
				t.Fatalf("%s does not resolve to %q: %q %v", name, want, got, err)
			}
		}
	}

	// v0.4.0 layout, then the old binary installs v0.5.0 at its own path.
	if err := os.Symlink(alias, legacyPathLink); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(alias, candidateTestBytes("v0.5.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensurePathLinkIn(canonical, alias, pathLink, legacyPathLink); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Lstat(alias); err != nil || !st.Mode().IsRegular() {
		t.Fatalf("the only copy was replaced: %v %v", st, err)
	}
	resolvesTo(candidateTestBytes("v0.5.0"), canonical, alias, pathLink, legacyPathLink)

	// Rollback by the old binary: it rewrites its own path, every name follows.
	if err := fsx.WriteAtomic(alias, candidateTestBytes("v0.4.0"), 0o755, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	resolvesTo(candidateTestBytes("v0.4.0"), canonical, pathLink, legacyPathLink)

	// Next upgrade run by this code, started through canonical: the running
	// executable resolves to alias, both get the bytes, then alias flips.
	if err := releaseAdoptedCanonical(canonical, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := selfupdate.Install(candidateTestBytes("v0.5.1"), fsx.Current(), upgradeTargets(canonical, alias, "")...); err != nil {
		t.Fatal(err)
	}
	if err := ensurePathLinkIn(canonical, alias, pathLink, legacyPathLink); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Lstat(canonical); err != nil || !st.Mode().IsRegular() {
		t.Fatalf("canonical is not a regular file after the flip: %v %v", st, err)
	}
	if got, _ := os.Readlink(alias); got != canonical {
		t.Fatalf("alias -> %q, want %q", got, canonical)
	}
	resolvesTo(candidateTestBytes("v0.5.1"), canonical, alias, pathLink, legacyPathLink)
}

func TestParseVersionOutput(t *testing.T) {
	if v := parseVersionOutput("edge-setup v0.0.2\n"); v != "v0.0.2" {
		t.Fatalf("got %q", v)
	}
	// A pre-rename installed binary asked mid-upgrade still answers under
	// its old name; candidateVersion/installedVersion must still parse it.
	if v := parseVersionOutput("hermes-setup v0.3.1\n"); v != "v0.3.1" {
		t.Fatalf("legacy name: got %q", v)
	}
	for _, bad := range []string{"", "garbage", "hermes-setup", "edge-setup", "other v1 x"} {
		if v := parseVersionOutput(bad); v != "" {
			t.Fatalf("%q parsed as %q", bad, v)
		}
	}
}

func TestFinishInlineDecision(t *testing.T) {
	a, b := strings.Repeat("a", 64), strings.Repeat("b", 64)
	if !finishInline(a, a) {
		t.Fatal("running binary is the candidate: finish must run inline")
	}
	if finishInline(a, b) {
		t.Fatal("running binary differs: the installed binary must be re-executed")
	}
	if finishInline("", b) {
		t.Fatal("unknown running digest must not be trusted as inline")
	}
}

func TestUpgradeGatesBeforeAnyWork(t *testing.T) {
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runUpgrade(env, nil); code != cli.ExitRefused || !strings.Contains(errb.String(), "nothing was changed") {
		t.Fatalf("missing --yes: code=%d err=%q", code, errb.String())
	}
	errb.Reset()
	if code := runUpgrade(env, []string{"--yes", "extra"}); code != cli.ExitUsage {
		t.Fatalf("positional argument: code=%d", code)
	}
	// The removed flag is named, with the replacement, before any other gate.
	for _, args := range [][]string{{"--yes", "--from", "/x", "--sha256", "ab"}, {"--from", "/x", "--sha256=ab"}} {
		errb.Reset()
		if code := runUpgrade(env, args); code != cli.ExitUsage || !strings.Contains(errb.String(), "--tag") || !strings.Contains(errb.String(), "deploy-key set") {
			t.Fatalf("--sha256 %v: code=%d err=%q", args, code, errb.String())
		}
	}
	// update --self without --yes forwards to the same refusal.
	errb.Reset()
	if code := runUpdate(env, []string{"--self"}); code != cli.ExitRefused || !strings.Contains(errb.String(), "nothing was changed") {
		t.Fatalf("update --self: code=%d err=%q", code, errb.String())
	}
	errb.Reset()
	if code := runUpdate(env, nil); code != cli.ExitNotImpl {
		t.Fatalf("update without --self: code=%d", code)
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// update --self is an alias: every flag after --self must reach upgrade.
func TestUpdateSelfForwardsAllFlags(t *testing.T) {
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runUpdate(env, []string{"--self", "--yes", "extra"}); code != cli.ExitUsage {
		t.Fatalf("positional after --self must be seen by upgrade: code=%d err=%q", code, errb.String())
	}
	errb.Reset()
	if code := runUpdate(env, []string{"--yes", "--self", "--from", "/nonexistent"}); code != cli.ExitPrivilege && code != cli.ExitUsage {
		t.Fatalf("--from must reach upgrade (gate order: root or --tag): code=%d err=%q", code, errb.String())
	}
}

// Without a deployment key the host cannot check any tag: --from is refused
// before anything is read or written. A malformed key is refused too, never
// silently treated as absent.
func TestRequireDeployKeyRefusesAbsentOrMalformed(t *testing.T) {
	dir := t.TempDir()
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if key, code := requireDeployKey(env, filepath.Join(dir, "missing")); key != nil || code != cli.ExitRefused || !strings.Contains(errb.String(), "deploy-key set") || !strings.Contains(errb.String(), "nothing was changed") {
		t.Fatalf("missing key: code=%d err=%q", code, errb.String())
	}
	errb.Reset()
	bad := writeTemp(t, dir, "deploy.key", []byte("not-a-key\n"))
	if key, code := requireDeployKey(env, bad); key != nil || code != cli.ExitRefused || !strings.Contains(errb.String(), "64 hex") {
		t.Fatalf("malformed key: code=%d err=%q", code, errb.String())
	}
	errb.Reset()
	good := writeTemp(t, dir, "good.key", []byte(" "+strings.ToUpper(strings.Repeat("0123456789abcdef", 4))+"\n"))
	if key, code := requireDeployKey(env, good); code != 0 || !bytes.Equal(key, testDeployKey) {
		t.Fatalf("valid key refused: code=%d err=%q", code, errb.String())
	}
}

// deploy-key set takes the secret on stdin only, validates it, and writes it
// private; a malformed line changes nothing and says why.
func TestDeployKeySetWritesPrivateFileAndRefusesMalformed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deploy.key")
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	for _, bad := range []string{"", "abc\n", strings.Repeat("g", 64) + "\n"} {
		errb.Reset()
		if code := deployKeySet(env, strings.NewReader(bad), path, fsx.Current()); code != cli.ExitUsage || !strings.Contains(errb.String(), "64 hex") {
			t.Fatalf("%q: code=%d err=%q", bad, code, errb.String())
		}
		if fileExists(path) {
			t.Fatalf("%q: key written despite refusal", bad)
		}
	}
	if code := deployKeySet(env, strings.NewReader(strings.ToUpper(strings.Repeat("0123456789abcdef", 4))+"\n"), path, fsx.Current()); code != cli.ExitOK {
		t.Fatalf("set: code=%d err=%q", code, errb.String())
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode: %v err=%v", st, err)
	}
	if key, err := readDeployKey(path); err != nil || !bytes.Equal(key, testDeployKey) {
		t.Fatalf("stored key unreadable: %v", err)
	}
	if strings.Contains(out.String(), strings.Repeat("0123456789abcdef", 4)) {
		t.Fatal("key value printed")
	}
	out.Reset()
	if code := deployKeyStatus(env, path); code != cli.ExitOK || !strings.Contains(out.String(), "present") || strings.Contains(out.String(), "0123456789abcdef") {
		t.Fatalf("status present: code=%d out=%q", code, out.String())
	}
	out.Reset()
	if code := deployKeyStatus(env, filepath.Join(dir, "none")); code != cli.ExitOK || !strings.Contains(out.String(), "absent") {
		t.Fatalf("status absent: code=%d out=%q", code, out.String())
	}
}

func TestRefuseDowngrade(t *testing.T) {
	cases := []struct {
		installed, candidate string
		allow                bool
		wantErr, wantNote    bool
	}{
		{"v1.2.3", "v1.2.2", false, true, false},
		{"v1.2.3", "v1.2.3", false, false, false},
		{"v1.2.3", "v1.3.0", false, false, false},
		{"v1.3.0", "v1.3.0-rc1", false, true, false},
		{"v1.2.3", "v1.2.2", true, false, false},
		{"dev", "v1.0.0", false, false, true},
		{"v1.0.0", "abc123", false, false, true},
		// `git describe --dirty` yields a valid semver pre-release: it still
		// orders, and v0.9.0 is older.
		{"v1.0.0-dirty", "v0.9.0", false, true, false},
		{"v1.0.0", "v1.0.1-3-gabc123", false, false, false},
		// One commit past a tag is newer than the tag, dirty or not: semver
		// alone compared "1-g44c185a-dirty" with "dirty" as text and refused.
		{"v0.3.0-dirty", "v0.3.0-1-g44c185a-dirty", false, false, false},
		{"v0.3.0", "v0.3.0-1-g44c185a", false, false, false},
		{"v0.3.0-1-g44c185a", "v0.3.0", false, true, false},
		{"v0.3.0-12-gabc1234", "v0.3.0-2-gdef5678", false, true, false},
		{"v0.3.0-dirty", "v0.3.0", false, false, false},
		{"v0.3.0-rc1", "v0.3.0-1-gabc1234", false, false, false},
	}
	for _, c := range cases {
		note, err := refuseDowngrade(c.installed, c.candidate, c.allow)
		if (err != nil) != c.wantErr || (note != "") != c.wantNote {
			t.Errorf("%s -> %s allow=%v: note=%q err=%v", c.installed, c.candidate, c.allow, note, err)
		}
	}
}

func TestUpgradeReconcilesNewSecurityDefaultsAndProvesGatewayRestart(t *testing.T) {
	managed := filepath.Join(t.TempDir(), "etc-hermes", "config.yaml")
	defer func(path string, owner fsx.Owner) { hermes.ManagedConfigPath, hermes.ManagedConfigOwner = path, owner }(hermes.ManagedConfigPath, hermes.ManagedConfigOwner)
	hermes.ManagedConfigPath, hermes.ManagedConfigOwner = managed, fsx.Current()
	fake := exectest.NewFake()
	for _, kv := range hermes.SecurityDefaults {
		if kv.Key != "gateway.multiplex_profiles" {
			fake.On(hermes.CLI("config", "get", kv.Key).String(), exec.Result{Stdout: kv.Value + "\n"})
		}
	}
	fake.On(hermes.CLI("config", "set", "gateway.multiplex_profiles", "true").String(), exec.Result{})
	fake.On("/usr/bin/systemctl restart hermes-gateway", exec.Result{})
	runner := &multiplexDefaultsRunner{fake: fake}
	healthy := false
	changed, err := reconcileUpgradeSecurityDefaults(context.Background(), runner, systemd.Client{Runner: fake}, func(context.Context) error {
		healthy = true
		return nil
	}, nil)
	if err != nil || !changed || !healthy || !fake.Ran("/usr/bin/systemctl restart hermes-gateway") {
		t.Fatalf("changed=%v healthy=%v err=%v calls=%v", changed, healthy, err, fake.Commands())
	}
	if got, err := os.ReadFile(managed); err != nil || string(got) != hermes.ManagedConfig {
		t.Fatalf("upgrade did not write the Hermes managed scope: %q, %v", got, err)
	}
}

type multiplexDefaultsRunner struct {
	fake  *exectest.Fake
	reads int
}

func (r *multiplexDefaultsRunner) Run(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	if c.String() == hermes.CLI("config", "get", "gateway.multiplex_profiles").String() {
		r.reads++
		if r.reads == 1 {
			return exec.Result{Stdout: "\n"}, nil
		}
		return exec.Result{Stdout: "true\n"}, nil
	}
	return r.fake.Run(ctx, c)
}

func TestCandidateVersionRunsAndCleansUp(t *testing.T) {
	dir := t.TempDir()
	script := []byte("#!/bin/sh\necho edge-setup v9.9.9\n")
	v, err := candidateVersion(context.Background(), dir, script, fsx.Current())
	if err != nil || v != "v9.9.9" {
		t.Fatalf("v=%q err=%v", v, err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("candidate left behind: %v", entries)
	}
	if _, err := candidateVersion(context.Background(), dir, []byte("#!/bin/sh\necho garbage\n"), fsx.Current()); err == nil {
		t.Fatal("non-version output accepted")
	}
	if _, err := candidateVersion(context.Background(), dir, []byte("not executable"), fsx.Current()); err == nil {
		t.Fatal("unrunnable candidate accepted")
	}
}

func TestUpgradeRefusesMixedSources(t *testing.T) {
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runUpgrade(env, []string{"--yes", "--from", "/x", "--release-url", "https://example.com"}); code != cli.ExitUsage {
		t.Fatalf("--from with --release-url: code=%d", code)
	}
	if code := runUpgrade(env, []string{"--yes", "--auto", "--allow-downgrade"}); code != cli.ExitUsage || !strings.Contains(errb.String(), "--auto") {
		t.Fatalf("--auto with --allow-downgrade: code=%d err=%q", code, errb.String())
	}
	for name, args := range map[string][]string{
		"--auto with --version":   {"--yes", "--auto", "--version", "v1.2.3"},
		"--from with --version":   {"--yes", "--from", "/x", "--version", "v1.2.3"},
		"--version not a release": {"--yes", "--version", "latest"},
		"--version prerelease":    {"--yes", "--version", "v1.2.3-rc1"},
	} {
		errb.Reset()
		if code := runUpgrade(env, args); code != cli.ExitUsage || !strings.Contains(errb.String(), "--") {
			t.Fatalf("%s: code=%d err=%q", name, code, errb.String())
		}
	}
}

// The retired public GitHub releases repository is refused before root, a
// lock or any download: exit 2, nothing changed.
func TestReleaseURLRefusesLegacyGitHubBase(t *testing.T) {
	const legacy = "https://github.com/MakFly/edge-setup-releases/releases/latest/download"
	for _, args := range [][]string{
		{"--yes", "--release-url", legacy},
		{"--yes", "--auto", "--release-url", legacy},
	} {
		var out, errb bytes.Buffer
		env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
		if code := runUpgrade(env, args); code != cli.ExitRefused || !strings.Contains(errb.String(), "retired") {
			t.Fatalf("upgrade %v: code=%d err=%q", args, code, errb.String())
		}
	}
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runSelfVerify(env, []string{"--release-url", legacy}); code != cli.ExitRefused || !strings.Contains(errb.String(), "retired") {
		t.Fatalf("self-verify: code=%d err=%q", code, errb.String())
	}
}
