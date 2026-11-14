package hermes

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

func TestResetDirtyCheckoutRestoresManagedTree(t *testing.T) {
	fake := exectest.NewFake().
		On("/usr/bin/git -C /usr/local/lib/hermes-agent reset --hard HEAD", exec.Result{}).
		On("/usr/bin/git -C /usr/local/lib/hermes-agent clean -ffd --", exec.Result{})
	i := &Installer{Runner: fake}

	if err := i.resetDirtyCheckout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !fake.Ran("/usr/bin/git -C /usr/local/lib/hermes-agent reset --hard HEAD") {
		t.Fatal("managed checkout was not reset")
	}
	if !fake.Ran("/usr/bin/git -C /usr/local/lib/hermes-agent clean -ffd --") {
		t.Fatal("untracked files were not removed")
	}
}

func TestRootOwnedSourceSkipsVenvAndPackageManagerSymlinks(t *testing.T) {
	want := "/usr/local/lib/hermes-agent -xdev ( -path /usr/local/lib/hermes-agent/venv -o -type l ) -prune -o ( ! -user root -o -perm /022 ) -print -quit"
	got := strings.Join(rootOwnedSourceArgs(true), " ")
	if got != want {
		t.Fatalf("find args = %q, want %q", got, want)
	}

	withoutVenv := strings.Join(rootOwnedSourceArgs(false), " ")
	if strings.Contains(withoutVenv, "/venv") || !strings.Contains(withoutVenv, "-type l -prune") {
		t.Fatalf("post-sync find args must prune symlinks without pruning venv: %q", withoutVenv)
	}
}

func TestRuntimeEnvRoundTrip(t *testing.T) {
	tok, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(tok) {
		t.Fatalf("token %q", tok)
	}
	env := RuntimeEnvContent(tok)
	want := "API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY=" + tok + "\nAPI_SERVER_CORS_ORIGINS=\n"
	if env != want {
		t.Fatalf("env:\n%s", env)
	}
	if ReadToken(env) != tok {
		t.Fatal("ReadToken")
	}
	if ReadToken("API_SERVER_ENABLED=true\n") != "" {
		t.Fatal("missing token must read empty")
	}
}

func TestCLIRunsAsServiceUserWithoutSecretsInArgv(t *testing.T) {
	c := CLI("auth", "add", "anthropic", "--type", "api-key", "--label", "prod")
	s := c.String()
	for _, want := range []string{"/usr/sbin/runuser -u hermes -- /usr/bin/env", "HERMES_HOME=/srv/hermes/data", "/usr/local/lib/hermes-agent/venv/bin/hermes auth add anthropic"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in %q", want, s)
		}
	}
	if strings.Contains(s, "--api-key") {
		t.Error("the CLI must never receive a secret flag")
	}
}

func TestUVEnvIsIsolated(t *testing.T) {
	env := strings.Join(UVEnv(), "\n")
	for _, want := range []string{"XDG_CONFIG_HOME=/usr/local/lib/hermes-uv/xdg-config", "UV_PYTHON_INSTALL_DIR=/usr/local/share/hermes-python", "UV_CACHE_DIR=/var/cache/hermes/uv"} {
		if !strings.Contains(env, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(env, "UV_NO_CONFIG") {
		t.Error("UV_NO_CONFIG must stay unset so the checkout's audited [tool.uv] overrides apply")
	}
}

func TestSecurityDefaultsAreFailClosed(t *testing.T) {
	want := map[string]string{"approvals.mode": "manual", "approvals.cron_mode": "deny", "approvals.single_query_mode": "deny", "security.allow_lazy_installs": "false", "gateway.multiplex_profiles": "true"}
	if len(SecurityDefaults) != len(want) {
		t.Fatalf("%v", SecurityDefaults)
	}
	for _, kv := range SecurityDefaults {
		if want[kv.Key] != kv.Value {
			t.Errorf("%s=%s", kv.Key, kv.Value)
		}
	}
}

func TestInstallStampUsesPinnedManagedVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install-stamp.json")
	if err := writeInstallStamp(path, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"commit": "` + pins.HermesInstallerCommit + `"`, `"baseVersion": "` + pins.HermesVersion + `"`, `"updateMechanism": "external"`} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("stamp missing %q: %s", want, data)
		}
	}
}

func TestProveVersionUsesStampBackedCLIHome(t *testing.T) {
	home := t.TempDir()
	command := cliAtHome(home, "--version")
	fake := exectest.NewFake().On(command.String(), exec.Result{Stdout: "Hermes Agent v" + pins.HermesVersion + "\n"})
	i := &Installer{Runner: fake, versionHome: home}
	if err := i.proveVersion(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fake.Calls) != 1 || !strings.Contains(strings.Join(fake.Calls[0].Args, " "), "HERMES_HOME="+home) {
		t.Fatalf("version proof did not use the private Hermes home: %+v", fake.Calls)
	}
}

func TestMirrorDotEnvDeltaUpdatesEveryNamedProfileButNotItsOwnBearer(t *testing.T) {
	root := t.TempDir()
	profileDir := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(profileDir, ".env")
	if err := os.WriteFile(path, []byte("ANTHROPIC_API_KEY=old\nAPI_SERVER_KEY=profile-bearer\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := map[string]string{"ANTHROPIC_API_KEY": "old", "OPENAI_API_KEY": "gone", "API_SERVER_KEY": "root-bearer"}
	after := map[string]string{"ANTHROPIC_API_KEY": "new", "OPENAI_API_KEY": "added", "API_SERVER_KEY": "root-bearer-rotated"}
	if err := MirrorDotEnvDelta(root, before, after, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "ANTHROPIC_API_KEY=new\n") || !strings.Contains(got, "OPENAI_API_KEY=added\n") || !strings.Contains(got, "API_SERVER_KEY=profile-bearer\n") || strings.Contains(got, "gone") {
		t.Fatalf("profile env %q", got)
	}
	if mode := func() os.FileMode { st, _ := os.Stat(path); return st.Mode().Perm() }(); mode != 0o600 {
		t.Fatalf("profile env mode %04o", mode)
	}
}

func TestMirrorDotEnvDeltaDoesNotOverwriteProfileOwnedKeys(t *testing.T) {
	root := t.TempDir()
	profileDir := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(profileDir, ".env")
	if err := os.WriteFile(path, []byte("ANTHROPIC_API_KEY=profile-own\nOPENAI_API_KEY=mirrored\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, ".env.openedbot-own"), []byte("# openedbot:profile-own\nANTHROPIC_API_KEY\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := map[string]string{"ANTHROPIC_API_KEY": "old-root", "OPENAI_API_KEY": "old-openai"}
	after := map[string]string{"ANTHROPIC_API_KEY": "new-root", "OPENAI_API_KEY": "new-openai"}
	if err := MirrorDotEnvDelta(root, before, after, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "ANTHROPIC_API_KEY=profile-own\n") {
		t.Fatalf("owned key was overwritten: %q", got)
	}
	if !strings.Contains(got, "OPENAI_API_KEY=new-openai\n") {
		t.Fatalf("unowned key was not mirrored: %q", got)
	}
}

func TestMirrorDotEnvDeltaNeverMirrorsAFileSwappedInForTheProfileEnv(t *testing.T) {
	root := t.TempDir()
	env := filepath.Join(root, "profiles", "scout", ".env")
	writeStoreFile(t, env, "KEEP=1\n", fsx.Current())
	rootOnly := filepath.Join(t.TempDir(), "root-only.env")
	if err := os.WriteFile(rootOnly, []byte("LEAK=hunter2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The profile .env is opened twice: for its own keys, then for the content
	// the mirror rewrites. The second one is the read the leak would come from.
	swapOnOpen(t, env, rootOnly, 2)
	before, after := map[string]string{"A": "old"}, map[string]string{"A": "new"}
	if err := MirrorDotEnvDelta(root, before, after, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(env)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "KEEP=1\nA=new\n" {
		t.Fatalf("profile env %q: lines of the file the name was swapped for were mirrored", got)
	}
}

func TestWriteRuntimeEnvNeverKeepsTheTokenOfAFileSwappedInAfterTheCheck(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.env")
	writeStoreFile(t, path, RuntimeEnvContent(strings.Repeat("ab", 32)), fsx.Current())
	if _, err := writeRuntimeEnvAt(path, fsx.Current(), nil); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "other.env")
	if err := os.WriteFile(other, []byte("API_SERVER_KEY="+strings.Repeat("cd", 32)+"\nOTHER=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Tightening opens the file first, the read of the existing token is the second open.
	swapOnOpen(t, path, other, 2)
	changed, err := writeRuntimeEnvAt(path, fsx.Current(), nil)
	if err != nil || changed {
		t.Fatalf("changed=%v err=%v: the token of the file the name was swapped for was taken over", changed, err)
	}
}

func TestRestoreGatewayStartsAgainOnlyWhatStillProvesItself(t *testing.T) {
	version := exec.Result{Stdout: "hermes " + pins.HermesVersion + "\n"}
	fake := exectest.NewFake().
		OnPrefix("/usr/sbin/runuser -u hermes --", version).
		On("/usr/bin/systemctl start hermes-gateway", exec.Result{})
	i := &Installer{Runner: fake, Systemd: systemd.Client{Runner: fake}, Log: func(string, ...any) {}}
	i.stoppedGateway = true

	i.restoreGateway(context.Background())

	if !fake.Ran("/usr/bin/systemctl start hermes-gateway") {
		t.Fatal("a provable installation must be started again")
	}
	if i.stoppedGateway {
		t.Fatal("the pass still believes it owes a gateway")
	}
}

func TestRestoreGatewayLeavesAHalfWrittenInstallationDown(t *testing.T) {
	fake := exectest.NewFake().
		OnPrefix("/usr/sbin/runuser -u hermes --", exec.Result{ExitCode: 127, Stderr: "no such file"}).
		On("/usr/bin/systemctl start hermes-gateway", exec.Result{})
	var logged []string
	i := &Installer{Runner: fake, Systemd: systemd.Client{Runner: fake}, Log: func(f string, a ...any) {
		logged = append(logged, fmt.Sprintf(f, a...))
	}}
	i.stoppedGateway = true

	i.restoreGateway(context.Background())

	if fake.Ran("/usr/bin/systemctl start hermes-gateway") {
		t.Fatal("an unprovable installation must not be started")
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "left stopped") {
		t.Fatalf("the reason must be printed, got %v", logged)
	}
}

func TestRestoreGatewayDoesNothingWhenThisPassStoppedNothing(t *testing.T) {
	fake := exectest.NewFake()
	i := &Installer{Runner: fake, Systemd: systemd.Client{Runner: fake}, Log: func(string, ...any) {}}

	i.restoreGateway(context.Background())

	if len(fake.Commands()) != 0 {
		t.Fatalf("no command expected, got %v", fake.Commands())
	}
}

func TestRequireRootOwnedSourceReclaimsBuildArtefactsThenProvesAgain(t *testing.T) {
	// A bridge installed by a root-run `hermes whatsapp` leaves a
	// node_modules the proof rejects; git ignores it, so no reset removes it.
	tree := t.TempDir()
	artefact := filepath.Join(tree, "node_modules")
	if err := os.MkdirAll(artefact, 0o775); err != nil {
		t.Fatal(err)
	}
	offender := filepath.Join(artefact, "baileys", "package.json")
	if err := os.MkdirAll(filepath.Dir(offender), 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(offender, []byte("{}"), 0o664); err != nil {
		t.Fatal(err)
	}
	proof := "/usr/bin/find " + strings.Join(rootOwnedSourceArgs(true), " ")
	scan := "/usr/bin/find " + strings.Join(sourceScanArgs(true, false), " ")
	fake := exectest.NewFake().
		OnSequence(proof, exec.Result{Stdout: offender + "\n"}, exec.Result{}).
		On(scan, exec.Result{Stdout: offender + "\n"}).
		On("/bin/chown -R root:root "+artefact, exec.Result{}).
		On("/bin/chmod -R u=rwX,g=rX,o=rX "+artefact, exec.Result{})
	i := &Installer{Runner: fake, Log: func(string, ...any) {}}

	if err := i.requireRootOwnedSource(context.Background(), true); err != nil {
		t.Fatalf("a reclaimable artefact must not fail the install: %v", err)
	}
	if !fake.Ran("/bin/chown -R root:root " + artefact) {
		t.Fatal("the artefact tree was not reclaimed")
	}
}

func TestRequireRootOwnedSourceStillFailsOnWhatItCannotRepair(t *testing.T) {
	stubborn := "/usr/local/lib/hermes-agent/gateway/run.py"
	proof := "/usr/bin/find " + strings.Join(rootOwnedSourceArgs(false), " ")
	scan := "/usr/bin/find " + strings.Join(sourceScanArgs(false, false), " ")
	fake := exectest.NewFake().
		On(proof, exec.Result{Stdout: stubborn + "\n"}).
		On(scan, exec.Result{Stdout: stubborn + "\n"})
	i := &Installer{Runner: fake, Log: func(string, ...any) {}}

	err := i.requireRootOwnedSource(context.Background(), false)
	if err == nil || !strings.Contains(err.Error(), "hermes code writable outside root") {
		t.Fatalf("the invariant must still be proven, got %v", err)
	}
}
