//go:build linux

package commands

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// defaultInstance sits next to its only users, which are linux-only: kept in the
// shared test helpers it would be unused (staticcheck U1000) in a darwin build.
const defaultInstance = layout.DefaultConnectorInstance

func redirectDeviceKey(t *testing.T) string {
	t.Helper()
	return redirectConnectorRoot(t)
}

// scanForSeed fails when the seed appears, in any encoding, in any file
// under dir: the module must never write the private key in clear.
func scanForSeed(t *testing.T, dir string, seed []byte) {
	t.Helper()
	encoded := base64.StdEncoding.EncodeToString(seed)
	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		data, _ := os.ReadFile(path)
		if bytes.Contains(data, seed) || bytes.Contains(data, []byte(encoded)) {
			t.Errorf("%s holds the device seed in clear", path)
		}
		return nil
	})
}

func TestSealDeviceKeyWritesOnlyTheSealedCredential(t *testing.T) {
	dir := redirectDeviceKey(t)
	fake := exectest.NewFake().OnPrefix("/usr/bin/systemd-creds encrypt", exec.Result{Stdout: "SEALED-BLOB"})
	priv, err := newDeviceKey(context.Background(), fake, defaultInstance, func(string, ...any) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.Calls) != 1 || !strings.Contains(fake.Calls[0].String(), "--name=device.key --with-key=host - -") {
		t.Fatalf("systemd-creds call %v", fake.Commands())
	}
	if !bytes.Equal(fake.Calls[0].Stdin, enroll.EncodeDeviceSeed(priv)) {
		t.Fatal("the seed did not travel on stdin")
	}
	data, err := os.ReadFile(deviceKeyPathOf(defaultInstance))
	if err != nil || string(data) != "SEALED-BLOB" {
		t.Fatalf("sealed credential: %v %q", err, data)
	}
	if info, _ := os.Stat(deviceKeyPathOf(defaultInstance)); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	scanForSeed(t, dir, priv.Seed())
}

func TestSealDeviceKeyBindsToTPMWhenPresent(t *testing.T) {
	dir := redirectDeviceKey(t)
	tpmDevice = filepath.Join(dir, "tpmrm0")
	if err := os.WriteFile(tpmDevice, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	fake := exectest.NewFake().OnPrefix("/usr/bin/systemd-creds encrypt", exec.Result{Stdout: "SEALED"})
	if _, err := newDeviceKey(context.Background(), fake, defaultInstance, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fake.Calls[0].String(), "--with-key=tpm2") {
		t.Fatalf("%v", fake.Commands())
	}
	empty := exectest.NewFake().OnPrefix("/usr/bin/systemd-creds encrypt", exec.Result{Stdout: ""})
	if _, err := newDeviceKey(context.Background(), empty, defaultInstance, func(string, ...any) {}); err == nil {
		t.Fatal("an empty credential was accepted")
	}
}

func TestEnsureDeviceKeysIsANoOpOnAnUnlinkedHost(t *testing.T) {
	redirectDeviceKey(t)
	// The fake has no script: any command would fail the test loudly.
	if err := ensureDeviceKeys(context.Background(), exectest.NewFake(), func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}
}

// upgrade seals a key for every linked instance that lacks one, and never
// touches an instance that already has its key.
func TestEnsureDeviceKeysCoversEveryLinkedInstance(t *testing.T) {
	redirectConnectorRoot(t)
	writeLink(t, defaultInstance, "https://console.openedbot.app", "rt-prod")
	writeLink(t, layout.ConnectorInstance("dev"), "http://127.0.0.1:8790", "rt-dev")
	writeLink(t, layout.ConnectorInstance("staging"), "https://staging.example", "rt-staging")
	if err := os.WriteFile(deviceKeyPathOf("staging"), []byte("KEPT"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := exectest.NewFake().OnPrefix("/usr/bin/systemd-creds encrypt", exec.Result{Stdout: "SEALED"})
	if err := ensureDeviceKeys(context.Background(), fake, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("systemd-creds ran %d times, want 2: %v", len(fake.Calls), fake.Commands())
	}
	for inst, want := range map[layout.ConnectorInstance]string{defaultInstance: "SEALED", "dev": "SEALED", "staging": "KEPT"} {
		if data, err := os.ReadFile(deviceKeyPathOf(inst)); err != nil || string(data) != want {
			t.Errorf("instance %s: key=%q err=%v", inst.Label(), data, err)
		}
	}
}

func TestLoadDeviceKeyReadsTheUnsealedSeed(t *testing.T) {
	credDir := t.TempDir()
	priv, _ := enroll.GenerateDeviceKey()
	if _, err := loadDeviceKey(credDir); err == nil || !strings.Contains(err.Error(), "device.key credential is missing") {
		t.Fatalf("missing credential: %v", err)
	}
	if err := os.WriteFile(filepath.Join(credDir, "device.key"), enroll.EncodeDeviceSeed(priv), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := loadDeviceKey(credDir)
	if err != nil || !got.Equal(priv) {
		t.Fatalf("%v", err)
	}
}

func TestConnectorDaemonRefusesToStartWithoutDeviceKey(t *testing.T) {
	credDir, stateDir := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(credDir, "runtime.env"), []byte("API_SERVER_KEY=abc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := `{"schema":1,"ohb":"https://ohb.example","ws_url":"wss://ohb.example/api/runtime-links/ws","runtime_id":"rt-1","link_token":"tok","linked_at":"2026-09-06T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(credDir, "link.json"), []byte(link), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CREDENTIALS_DIRECTORY", credDir)
	t.Setenv("STATE_DIRECTORY", stateDir)
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runConnectorDaemon(env); code != cli.ExitRefused {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
	if !strings.Contains(errb.String(), "device.key credential is missing") || !strings.Contains(errb.String(), "nothing was started") {
		t.Fatalf("stderr=%q", errb.String())
	}
	if entries, _ := os.ReadDir(stateDir); len(entries) != 0 {
		t.Fatal("the daemon touched its state directory before refusing")
	}
}

func TestLinkRekeyGates(t *testing.T) {
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runLink(env, []string{"--rekey"}); code != cli.ExitRefused || !strings.Contains(errb.String(), "add --yes") {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
	errb.Reset()
	if code := runLink(env, []string{"--rekey", "--yes", "--ohb", "https://ohb.example"}); code != cli.ExitUsage || !strings.Contains(errb.String(), "takes no ticket") {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
}
