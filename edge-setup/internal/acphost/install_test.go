package acphost

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

type fixtureTransport struct {
	t     *testing.T
	data  []byte
	calls int
}

func (f *fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	f.t.Helper()
	if r.URL.String() != pins.OpenCodeArchiveURL(pins.OpenCodeArches["amd64"]) {
		f.t.Fatal("unexpected release URL")
	}
	f.calls++
	return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(f.data)), Header: make(http.Header)}, nil
}

func installerFixture(t *testing.T) (*Installer, *exectest.Fake, *fixtureTransport) {
	t.Helper()
	root := t.TempDir()
	p := Paths{root + "/runtime", root + "/agent", root + "/runtime/profiles", root + "/state", root + "/opencode", root + "/provider.env", root + "/download", root + "/bridge.service"}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	data := []byte("fake opencode binary")
	if err := tw.WriteHeader(&tar.Header{Name: "opencode", Mode: 0o755, Size: int64(len(data))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	old := pins.OpenCodeArches["amd64"]
	pin := old
	pin.SHA256 = fmt.Sprintf("%x", sha256.Sum256(buf.Bytes()))
	pins.OpenCodeArches["amd64"] = pin
	t.Cleanup(func() { pins.OpenCodeArches["amd64"] = old })
	transport := &fixtureTransport{t: t, data: buf.Bytes()}
	f := exectest.NewFake()
	f.On("/usr/bin/getent passwd hermes", exec.Result{Stdout: "hermes:x:998:998::/home/hermes:/usr/sbin/nologin\n"})
	f.On("/usr/bin/id -nG hermes", exec.Result{Stdout: "hermes\n"})
	f.On(agentCommand(p, "--version").String(), exec.Result{Stdout: pins.OpenCodeVersion + "\n"})
	f.OnPrefix("/usr/bin/systemctl ", exec.Result{})
	f.OnPrefix("/usr/bin/apt-get install ", exec.Result{})
	acc := account.Client{Runner: f, Lookup: func(name string) (*user.User, error) {
		return &user.User{Uid: strconv.Itoa(os.Geteuid()), Gid: strconv.Itoa(os.Getegid()), Username: name}, nil
	}}
	return &Installer{Runner: f, Apt: apt.Client{Runner: f, PolicyRcD: root + "/policy-rc.d"}, Accounts: acc, Download: download.Client{HTTP: &http.Client{Transport: transport}}, Paths: p, Owner: fsx.Current(), Arch: "amd64", Log: func(string, ...any) {}}, f, transport
}

func TestInstallPlanAndReplayKeepBearer(t *testing.T) {
	i, f, transport := installerFixture(t)
	if err := i.Run(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	want := []string{"/usr/bin/apt-get install -y --no-install-recommends ca-certificates git iproute2 passwd util-linux", "/usr/bin/getent passwd hermes", "/usr/bin/id -nG hermes", agentCommand(i.Paths, "--version").String(), "/usr/bin/systemctl daemon-reload", "/usr/bin/systemctl enable --now openedbot-acp-bridge", "/usr/bin/systemctl restart openedbot-acp-bridge"}
	if !reflect.DeepEqual(f.Commands(), want) {
		t.Fatalf("commands: %v", f.Commands())
	}
	before, err := fsx.ReadRegular(i.Paths.Runtime+"/runtime.env", 0o600, i.Owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) == 0 {
		t.Fatal("missing bearer file")
	}
	for path, mode := range map[string]os.FileMode{i.Paths.Runtime: 0o755, i.Paths.State: 0o700, i.Paths.Profiles: 0o700, i.Paths.Config + "/opencode.json": 0o644, i.Paths.Agent + "/opencode": 0o755, i.Paths.Runtime + "/.env": 0o600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("mode for %s", path)
		}
	}
	if _, err := os.Stat(i.Paths.Credentials); !os.IsNotExist(err) {
		t.Fatal("installer must not create provider credentials")
	}
	f.Calls = nil
	if err := i.Run(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(i.Paths.Runtime + "/runtime.env")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) || transport.calls != 1 {
		t.Fatal("replay rotated bearer or downloaded again")
	}
	if !reflect.DeepEqual(f.Commands(), []string{want[0], want[1], want[2], want[4], want[5]}) {
		t.Fatalf("replay: %v", f.Commands())
	}
}

func TestUpgradeReinstallsChangedPinAndRestartsBridge(t *testing.T) {
	i, f, transport := installerFixture(t)
	if err := i.Run(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(i.Paths.Agent+"/version", []byte("older-pin"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(i.Paths.Downloads); err != nil {
		t.Fatal(err)
	}
	f.Calls = nil
	if err := i.Run(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 2 || !f.Ran("/usr/bin/systemctl restart openedbot-acp-bridge") {
		t.Fatal("upgrade did not reinstall and restart")
	}
	for _, command := range f.Commands() {
		if strings.Contains(command, "hermes gateway") || strings.Contains(command, "python") {
			t.Fatal("Hermes command on ACP upgrade")
		}
	}
}

func TestDaemonOptionsKeepSecretsOutOfArguments(t *testing.T) {
	i, _, _ := installerFixture(t)
	if err := i.Run(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	cred := t.TempDir()
	data, err := os.ReadFile(i.Paths.Runtime + "/runtime.env")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cred+"/runtime.env", data, 0o600); err != nil {
		t.Fatal(err)
	}
	const providerValue = "provider-fixture-value"
	if err := os.WriteFile(i.Paths.Credentials, []byte("OPENAI_API_KEY="+providerValue+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	st := state.New("test")
	st.Engine = state.EngineOpenCode
	opts, err := Options(i.Paths, st, cred, i.Owner)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(opts.AgentArguments, " ")
	if !strings.Contains(args, "XDG_CONFIG_HOME="+filepath.Dir(i.Paths.Config)+" ") || filepath.Base(i.Paths.Config) != "opencode" {
		t.Fatal("OpenCode global configuration directory is not provisioned")
	}
	if strings.Contains(args, providerValue) || strings.Contains(args, opts.Bearer) {
		t.Fatal("secret in argv")
	}
	if opts.AgentCommand != "/usr/sbin/runuser" || !strings.HasSuffix(args, "/opencode acp") || opts.ProfilesRoot != i.Paths.Profiles || opts.StateDirectory != i.Paths.State {
		t.Fatal("incorrect launch options")
	}
	for _, key := range []string{"OPENCODE_CONFIG=", "OPENCODE_CONFIG_DIR=", "OPENCODE_DISABLE_PROJECT_CONFIG=true"} {
		if !strings.Contains(args, key) {
			t.Fatal("missing configuration control", key)
		}
	}
	if !strings.Contains(strings.Join(opts.AgentEnvironmentValues, "\n"), "OPENAI_API_KEY="+providerValue) {
		t.Fatal("provider environment missing")
	}
	if err := os.Chmod(i.Paths.Credentials, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Options(i.Paths, st, cred, i.Owner); err == nil {
		t.Fatal("public credentials accepted")
	}
	if _, err := Options(i.Paths, nil, cred, i.Owner); err == nil {
		t.Fatal("Hermes state accepted")
	}
}

func TestChecksumFailureNeverInstallsOrStartsAgent(t *testing.T) {
	i, f, _ := installerFixture(t)
	pin := pins.OpenCodeArches["amd64"]
	pin.SHA256 = strings.Repeat("0", 64)
	pins.OpenCodeArches["amd64"] = pin
	if err := i.Run(context.Background(), false); !errors.Is(err, download.ErrChecksum) {
		t.Fatal("unverified archive accepted")
	}
	if _, err := os.Stat(i.Paths.Agent + "/opencode"); !os.IsNotExist(err) {
		t.Fatal("unverified binary installed")
	}
	for _, command := range f.Commands() {
		if strings.Contains(command, "systemctl") || strings.Contains(command, "runuser") {
			t.Fatal("unverified agent started")
		}
	}
}
