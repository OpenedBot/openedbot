package commands

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func writeRetireLink(t *testing.T, inst layout.ConnectorInstance) {
	t.Helper()
	data, err := json.Marshal(LinkFile{Schema: 1, Openedbot: "https://openedbot.example", WSURL: "wss://openedbot.example/api/runtime-links/ws", RuntimeID: "rt-1", LinkToken: "test-link-token"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(linkPathOf(inst)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(linkPathOf(inst), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func stubRetire(t *testing.T, key ed25519.PrivateKey, session func(context.Context, *connector.Client) error) {
	t.Helper()
	prevKey, prevSession := retireDeviceKey, retireSession
	retireDeviceKey = func(context.Context, layout.ConnectorInstance) (ed25519.PrivateKey, error) { return key, nil }
	retireSession = session
	t.Cleanup(func() { retireDeviceKey, retireSession = prevKey, prevSession })
}

func TestRetireLinkSkipsAnInstanceWithoutLink(t *testing.T) {
	redirectConnectorRoot(t)
	stubRetire(t, nil, func(context.Context, *connector.Client) error {
		t.Fatal("a session was opened for an instance without link")
		return nil
	})
	id, err := retireLink(context.Background(), cli.Env{}, layout.DefaultConnectorInstance)
	if id != "" || err != nil {
		t.Fatalf("id=%q err=%v", id, err)
	}
}

func TestRetireLinkProvesWithTheStoredIdentityAndNoGatewayBearer(t *testing.T) {
	redirectConnectorRoot(t)
	inst, _ := layout.ParseConnectorInstance("dev")
	writeRetireLink(t, inst)
	key, err := enroll.GenerateDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	var seen *connector.Client
	stubRetire(t, key, func(_ context.Context, c *connector.Client) error { seen = c; return nil })
	id, err := retireLink(context.Background(), cli.Env{Version: "v0.0.3"}, inst)
	if err != nil || id != "rt-1" {
		t.Fatalf("id=%q err=%v", id, err)
	}
	if seen.WSURL != "wss://openedbot.example/api/runtime-links/ws" || seen.Auth.RuntimeID != "rt-1" || seen.Auth.LinkToken != "test-link-token" || seen.Auth.EnrollmentTicket != "" {
		t.Fatalf("session identity %+v at %s", seen.Auth, seen.WSURL)
	}
	if !seen.DeviceKey.Equal(key) || seen.Bearer != "" || seen.Agent != "edge-setup/v0.0.3" {
		t.Fatalf("session key/bearer/agent: %v %q %q", seen.DeviceKey.Equal(key), seen.Bearer, seen.Agent)
	}
}

func TestRetireLinkReportsAnUnansweredRequest(t *testing.T) {
	redirectConnectorRoot(t)
	writeRetireLink(t, layout.DefaultConnectorInstance)
	prev := retireTimeout
	retireTimeout = 50 * time.Millisecond
	t.Cleanup(func() { retireTimeout = prev })
	stubRetire(t, nil, func(ctx context.Context, _ *connector.Client) error { <-ctx.Done(); return ctx.Err() })
	id, err := retireLink(context.Background(), cli.Env{}, layout.DefaultConnectorInstance)
	if id != "rt-1" || err == nil || !strings.Contains(err.Error(), "did not confirm") {
		t.Fatalf("id=%q err=%v", id, err)
	}
}

func TestReportRetireWarnsAndNamesWhereToRevoke(t *testing.T) {
	redirectConnectorRoot(t)
	writeRetireLink(t, layout.DefaultConnectorInstance)
	stubRetire(t, nil, func(context.Context, *connector.Client) error { return errors.New("dial: refused") })
	var stdout, stderr bytes.Buffer
	reportRetire(context.Background(), cli.Env{Stdout: &stdout, Stderr: &stderr}, layout.DefaultConnectorInstance)
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "rt-1") || !strings.Contains(stderr.String(), retireManualHint) {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if strings.Contains(stderr.String(), "test-link-token") {
		t.Fatal("the link token reached the warning")
	}
}

func TestUnsealDeviceKeyAsksSystemdCredsForTheNamedCredential(t *testing.T) {
	redirectConnectorRoot(t)
	inst, _ := layout.ParseConnectorInstance("dev")
	path := deviceKeyPathOf(inst)
	writeUnlinkFixtureFile(t, path)
	key, err := enroll.GenerateDeviceKey()
	if err != nil {
		t.Fatal(err)
	}
	command := "/usr/bin/systemd-creds decrypt --name=device.key " + path + " -"
	fake := exectest.NewFake().On(command, exec.Result{Stdout: string(enroll.EncodeDeviceSeed(key))})
	prev := runner
	runner = fake
	t.Cleanup(func() { runner = prev })
	got, err := unsealDeviceKey(context.Background(), inst)
	if err != nil || !got.Equal(key) {
		t.Fatalf("unsealed key differs: %v", err)
	}
	if !reflect.DeepEqual(fake.Commands(), []string{command}) {
		t.Fatalf("commands %v", fake.Commands())
	}
}

func TestUnsealDeviceKeyFailsClosedWithoutLeakingOutput(t *testing.T) {
	redirectConnectorRoot(t)
	path := deviceKeyPathOf(layout.DefaultConnectorInstance)
	prev := runner
	t.Cleanup(func() { runner = prev })

	runner = exectest.NewFake()
	if key, err := unsealDeviceKey(context.Background(), layout.DefaultConnectorInstance); key != nil || err != nil {
		t.Fatalf("absent key: %v %v", key, err)
	}

	writeUnlinkFixtureFile(t, path)
	runner = exectest.NewFake().OnPrefix("/usr/bin/systemd-creds decrypt", exec.Result{ExitCode: 1, Stdout: "partial-seed-bytes", Stderr: "tpm2 detail"})
	_, err := unsealDeviceKey(context.Background(), layout.DefaultConnectorInstance)
	if err == nil || strings.Contains(err.Error(), "partial-seed-bytes") || strings.Contains(err.Error(), "tpm2 detail") {
		t.Fatalf("unseal failure: %v", err)
	}

	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	runner = exectest.NewFake()
	if _, err := unsealDeviceKey(context.Background(), layout.DefaultConnectorInstance); err == nil {
		t.Fatal("a readable sealed key was used")
	}
}

func TestUnlinkInstanceRetiresAfterTheStopProofAndBeforeRemoval(t *testing.T) {
	fixture := newUnlinkFixture(t, "dev", false)
	deps, calls := unlinkTestDeps(fixture, "", true)
	deps.Retire = func(context.Context) {
		*calls = append(*calls, "retire")
		assertUnlinkPathsPresent(t, fixture.files)
	}
	if err := unlinkInstance(context.Background(), fixture.instance, fixture.owner, deps); err != nil {
		t.Fatal(err)
	}
	if want := []string{"stop", "inactive", "retire", "disable"}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("calls=%v, want %v", *calls, want)
	}

	failing := newUnlinkFixture(t, "prod", false)
	deps, calls = unlinkTestDeps(failing, "inactive", false)
	deps.Retire = func(context.Context) { *calls = append(*calls, "retire") }
	if err := unlinkInstance(context.Background(), failing.instance, failing.owner, deps); err == nil {
		t.Fatal("unlink went on without the stop proof")
	}
	if want := []string{"stop", "inactive"}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("a running connector was retired: %v", *calls)
	}
}
