package commands

import (
	"bytes"
	"context"
	"encoding/json"
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
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/term"
)

// The enrollment ticket is a bearer: argv reaches the process table and
// sudo's journal, so link must refuse a positional ticket.
func TestLinkRefusesPositionalTicket(t *testing.T) {
	ticket := "3f2504e0-4f89-11d3-9a0c-0305e82c3301.aaaaaaaaaaaaaaaa"
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	code := runLink(env, []string{"--openedbot", "https://openedbot.example", "--yes", ticket})
	if code != cli.ExitUsage {
		t.Errorf("link: code=%d, want %d", code, cli.ExitUsage)
	}
	if !strings.Contains(errb.String(), "never travels in argv") {
		t.Errorf("link: stderr=%q", errb.String())
	}
}

func TestCloudflareDevelopmentOriginBecomesSecureWebSocket(t *testing.T) {
	const origin = "https://openedbot-dev.example.trycloudflare.com"
	if got, want := wsURLOf(origin), "wss://openedbot-dev.example.trycloudflare.com/api/runtime-links/ws"; got != want {
		t.Fatalf("wsURLOf(%q) = %q, want %q", origin, got, want)
	}
}

// The loopback development origin keeps its scheme: wss on a port an SSH
// reverse tunnel serves in clear text would fail the handshake, not upgrade it.
func TestLoopbackDevelopmentOriginKeepsPlainWebSocket(t *testing.T) {
	const origin = "http://127.0.0.1:8790"
	if got, want := wsURLOf(origin), "ws://127.0.0.1:8790/api/runtime-links/ws"; got != want {
		t.Fatalf("wsURLOf(%q) = %q, want %q", origin, got, want)
	}
}

// Without --insecure-openedbot the http origin is refused before anything is read,
// and the refusal names the flag that would accept it.
func TestLinkRefusesPlainOriginWithoutTheDevelopmentFlag(t *testing.T) {
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runLink(env, []string{"--openedbot", "http://127.0.0.1:8790", "--yes"}); code != cli.ExitUsage {
		t.Fatalf("code=%d, want %d (%q)", code, cli.ExitUsage, errb.String())
	}
	if !strings.Contains(errb.String(), "https://") {
		t.Errorf("stderr=%q", errb.String())
	}
	if code := runLink(env, []string{"--openedbot", "http://openedbot.example", "--insecure-openedbot", "--yes"}); code != cli.ExitUsage {
		t.Fatalf("public http origin accepted: code=%d", code)
	}
	if !strings.Contains(errb.String(), "--insecure-openedbot") {
		t.Errorf("the refusal must name the loopback rule: %q", errb.String())
	}
}

// A ticket file the caller does not own in 0600 is refused before any
// network call.
func TestLinkTicketFileMustBe0600(t *testing.T) {
	dir := t.TempDir()
	loose := filepath.Join(dir, "ticket")
	if err := os.WriteFile(loose, []byte("3f2504e0-4f89-11d3-9a0c-0305e82c3301.aaaaaaaaaaaaaaaa\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Exercise the gate directly so this test cannot read an installed host's
	// configuration or prepare its LaunchAgent on macOS.
	if _, err := readSecret(loose, "enrollment ticket", "--ticket-file", ""); err == nil || !strings.Contains(err.Error(), "--ticket-file") {
		t.Fatalf("0644 ticket file accepted or not identified: %v", err)
	}
}

func TestReadSecretNamesTheSecret(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "t")
	if err := os.WriteFile(p, []byte("value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readSecret(p, "enrollment ticket", "--ticket-file", "")
	if err != nil || got != "value" {
		t.Fatalf("got %q err=%v", got, err)
	}
	if err := os.WriteFile(p, []byte("a\nb\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSecret(p, "enrollment ticket", "--ticket-file", ""); err == nil || !strings.Contains(err.Error(), "enrollment ticket must be a single line") {
		t.Fatalf("multi-line accepted: %v", err)
	}
	if err := os.WriteFile(p, []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSecret(p, "enrollment ticket", "--ticket-file", ""); err == nil || !strings.Contains(err.Error(), "enrollment ticket is empty") {
		t.Fatalf("empty accepted: %v", err)
	}
}

func TestRotatedLinkTokenIsDurableAndScopedToRuntime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "link-token.json")
	now := time.Date(2026, 9, 3, 13, 26, 0, 0, time.UTC)
	if err := persistRotatedLinkToken(path, "runtime-1", "token-2", now); err != nil {
		t.Fatal(err)
	}
	if got, err := loadRotatedLinkToken(path, "runtime-1"); err != nil || got != "token-2" {
		t.Fatalf("matching runtime: token=%q err=%v", got, err)
	}
	if got, err := loadRotatedLinkToken(path, "runtime-2"); err != nil || got != "" {
		t.Fatalf("fresh enrollment reused stale rotation: token=%q err=%v", got, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%v err=%v", info.Mode().Perm(), err)
	}
}

// The moved origin overlays link.json like the rotated token: durable, 0600,
// scoped to its runtime, and re-validated at every start.
func TestMovedLinkOriginIsDurableScopedAndValidated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "link-origin.json")
	now := time.Date(2026, 10, 6, 10, 30, 0, 0, time.UTC)
	const apex = "wss://openedbot.app/api/runtime-links/ws"
	if err := persistMovedLinkOrigin(path, "runtime-1", apex, now); err != nil {
		t.Fatal(err)
	}
	if got, err := loadMovedLinkOrigin(path, "runtime-1"); err != nil || got != apex {
		t.Fatalf("matching runtime: ws=%q err=%v", got, err)
	}
	if got, err := loadMovedLinkOrigin(path, "runtime-2"); err != nil || got != "" {
		t.Fatalf("fresh enrollment reused a stale move: ws=%q err=%v", got, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%v err=%v", info.Mode().Perm(), err)
	}
	if err := persistMovedLinkOrigin(path, "runtime-1", "ws://openedbot.app/api/runtime-links/ws", now); err == nil {
		t.Fatal("a plaintext public endpoint was persisted")
	}
	tampered := `{"schema":1,"runtime_id":"runtime-1","ws_url":"ws://openedbot.app/api/runtime-links/ws","moved_at":"x"}`
	if err := os.WriteFile(path, []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadMovedLinkOrigin(path, "runtime-1"); err == nil {
		t.Fatal("a tampered overlay was accepted")
	}
}

// The feature bound openedbot announced rides in link-context.json, so the
// first hello after a restart already honors it. The last announcement wins: a
// link.context that announced none clears it, and a file written before the
// field existed, or a bound that is not a positive integer, leaves the default.
func TestLinkContextCarriesTheFeatureBoundAcrossRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "link-context.json")
	now := time.Date(2026, 10, 11, 9, 0, 0, 0, time.UTC)
	announced := connector.LinkContext{Environment: "prod", Openedbot: "https://openedbot.app", Organization: connector.LinkOrganization{ID: "org-1", Name: "Acme", Slug: "acme"}, FeatureLimit: 64}
	if err := persistLinkContext(path, "rt-1", announced, now); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var onDisk struct {
		Limits struct {
			Features int `json:"features"`
		} `json:"limits"`
	}
	if err := json.Unmarshal(raw, &onDisk); err != nil || onDisk.Limits.Features != 64 {
		t.Fatalf("limits.features not on disk: %v\n%s", err, raw)
	}
	client := connector.New("", connector.Auth{}, "", "", nil)
	if client.FeatureBound() != connector.DefaultMaxFeatures {
		t.Fatalf("a new client starts at %d, not the default", client.FeatureBound())
	}
	restored := restoreLinkContext(client, path, LinkFile{RuntimeID: "rt-1"})
	if restored.FeatureLimit != 64 || restored.Organization.Name != "Acme" || client.FeatureBound() != 64 {
		t.Fatalf("restored %+v, client bound %d", restored, client.FeatureBound())
	}

	// Another runtime's overlay is not this link's: nothing is restored.
	other := connector.New("", connector.Auth{}, "", "", nil)
	if got := restoreLinkContext(other, path, LinkFile{RuntimeID: "rt-2", Environment: "dev"}); got.FeatureLimit != 0 || got.Environment != "dev" || other.FeatureBound() != connector.DefaultMaxFeatures {
		t.Fatalf("a stale overlay leaked: %+v, bound %d", got, other.FeatureBound())
	}

	// The last announcement wins: none clears the bound and the key.
	if err := persistLinkContext(path, "rt-1", connector.LinkContext{Environment: "prod", Openedbot: "https://openedbot.app"}, now); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(path); strings.Contains(string(raw), "limits") {
		t.Fatalf("a context without a bound still carries limits:\n%s", raw)
	}
	cleared := connector.New("", connector.Auth{}, "", "", nil)
	cleared.SetFeatureBound(64)
	restoreLinkContext(cleared, path, LinkFile{RuntimeID: "rt-1"})
	if cleared.FeatureBound() != connector.DefaultMaxFeatures {
		t.Fatalf("an overlay without limits left the bound at %d", cleared.FeatureBound())
	}

	// A file from an older daemon has no limits; a bound that is not a positive
	// integer is ignored and the rest of the context is kept.
	for name, limits := range map[string]string{"absent": "", "zero": `,"limits":{"features":0}`, "negative": `,"limits":{"features":-4}`, "empty": `,"limits":{}`} {
		body := `{"schema":1,"runtime_id":"rt-1","openedbot_environment":"prod","openedbot":"https://openedbot.app"` + limits + `,"received_at":"2026-10-01T00:00:00Z"}`
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		got, ok := loadLinkContext(path, "rt-1")
		if !ok || got.Environment != "prod" || got.FeatureLimit != 0 {
			t.Fatalf("%s: ok=%v context=%+v", name, ok, got)
		}
	}
}

// link.json is re-checked at every daemon start: wss:// toward any host,
// ws:// only toward loopback, and always the broker path.
func TestValidateWSURLAcceptsSecureAndLoopbackOnly(t *testing.T) {
	for _, ok := range []string{
		"wss://openedbot.example/api/runtime-links/ws",
		"wss://openedbot.example:8443/api/runtime-links/ws",
		"ws://127.0.0.1:8790/api/runtime-links/ws",
		"ws://localhost:8790/api/runtime-links/ws",
		"ws://[::1]:8790/api/runtime-links/ws",
	} {
		if err := validateWSURL(ok); err != nil {
			t.Errorf("%s refused: %v", ok, err)
		}
	}
}

func TestValidateWSURLRefusesPlainPublicOrigin(t *testing.T) {
	err := validateWSURL("ws://openedbot.example/api/runtime-links/ws")
	if err == nil || !strings.Contains(err.Error(), "wss://") {
		t.Fatalf("plain public origin accepted or refusal does not name wss://: %v", err)
	}
}

func TestValidateWSURLRefusesWrongPathSchemeOrExtras(t *testing.T) {
	for _, bad := range []string{
		"wss://openedbot.example/other",
		"wss://openedbot.example/api/runtime-links/ws?x=1",
		"wss://user:pw@openedbot.example/api/runtime-links/ws",
		"https://openedbot.example/api/runtime-links/ws",
		"wss:///api/runtime-links/ws",
	} {
		if err := validateWSURL(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

// writeLink persists a minimal link.json for an instance under the
// redirected connector root (the token is a placeholder).
func writeLink(t *testing.T, inst layout.ConnectorInstance, openedbot, runtimeID string) {
	t.Helper()
	lf := LinkFile{Schema: 1, Openedbot: openedbot, WSURL: wsURLOf(openedbot), RuntimeID: runtimeID, LinkToken: "tok", LinkedAt: "2026-09-06T00:00:00Z"}
	data, _ := json.Marshal(lf)
	if err := os.MkdirAll(inst.DirUnder(connectorRoot), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(linkPathOf(inst), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A host holds one link per instance and re-linking always wins: switching
// between a development openedbot and production is the same command with
// another --openedbot. Nothing is refused, so what this pins is the duty to speak:
// the previous origin and runtime are reported, and a fresh ticket on the
// origin already linked is a re-enrollment rather than a switch.
func TestLinkTakeoverNamesWhatItReplaces(t *testing.T) {
	redirectConnectorRoot(t)
	const prod, dev = "https://console.openedbot.app", "http://127.0.0.1:8790"

	if previous, switching := linkTakeover(layout.DefaultConnectorInstance, dev); previous != nil || switching {
		t.Fatalf("an unlinked host announced a takeover: previous=%+v switching=%v", previous, switching)
	}

	writeLink(t, layout.DefaultConnectorInstance, prod, "rt-prod")
	previous, switching := linkTakeover(layout.DefaultConnectorInstance, dev)
	if !switching {
		t.Fatal("moving the production link to a development origin was not reported as a switch")
	}
	if previous == nil || previous.Openedbot != prod || previous.RuntimeID != "rt-prod" {
		t.Fatalf("the takeover does not name the link it replaces: %+v", previous)
	}

	previous, switching = linkTakeover(layout.DefaultConnectorInstance, prod)
	if switching {
		t.Error("a new ticket on the origin already linked was reported as a switch")
	}
	if previous == nil || previous.RuntimeID != "rt-prod" {
		t.Fatalf("the re-enrollment lost the runtime it replaces: %+v", previous)
	}

	// A named instance is not a special case: it takes over the same way.
	writeLink(t, "dev", dev, "rt-dev")
	previous, switching = linkTakeover("dev", prod)
	if !switching || previous == nil || previous.Openedbot != dev || previous.RuntimeID != "rt-dev" {
		t.Fatalf("named instance takeover: previous=%+v switching=%v", previous, switching)
	}
}

// One gateway, one organization: a second instance may not dial an origin
// another instance already links (it would share the gateway's profiles and
// sessions with a second organization). Distinct origins (dev next to prod)
// and the re-enrollment of the same instance stay allowed.
func TestOriginTakenByFindsAnotherInstanceOnTheSameOrigin(t *testing.T) {
	redirectConnectorRoot(t)
	const prod, dev = "https://console.openedbot.app", "http://127.0.0.1:8790"

	if other, lf := originTakenBy("dev", dev); lf != nil {
		t.Fatalf("an unlinked host reported %q as taken by %q", dev, other)
	}
	writeLink(t, layout.DefaultConnectorInstance, prod, "rt-prod")
	if _, lf := originTakenBy("dev", dev); lf != nil {
		t.Fatal("a named instance on another origin (dev next to prod) was reported as taken")
	}
	if _, lf := originTakenBy(layout.DefaultConnectorInstance, prod); lf != nil {
		t.Fatal("re-enrolling the instance that already holds the origin was reported as taken")
	}
	other, lf := originTakenBy("second", prod)
	if lf == nil || other != layout.DefaultConnectorInstance || lf.RuntimeID != "rt-prod" {
		t.Fatalf("a second instance on the production origin was not refused: other=%q link=%+v", other, lf)
	}
	writeLink(t, "dev", dev, "rt-dev")
	if other, lf := originTakenBy(layout.DefaultConnectorInstance, dev); lf == nil || other != "dev" {
		t.Fatalf("the default instance moving onto the dev instance's origin was not refused: other=%q link=%+v", other, lf)
	}
}

func TestLinkRefusesAnInvalidInstanceName(t *testing.T) {
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runLink(env, []string{"--openedbot", "https://openedbot.example", "--yes", "--name", "Dev"}); code != cli.ExitUsage || !strings.Contains(errb.String(), "--name") {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
}

// status lists the default instance first, always, then every named
// instance with a link: origin and runtime id from link.json, activity from
// systemd, and whether a device key is sealed. The token never appears.
func TestConnectorStatusListsEveryInstance(t *testing.T) {
	redirectConnectorRoot(t)
	writeLink(t, layout.DefaultConnectorInstance, "https://console.openedbot.app", "rt-prod")
	writeLink(t, "dev", "http://127.0.0.1:8790", "rt-dev")
	if err := os.WriteFile(deviceKeyPathOf("dev"), []byte("SEALED"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A directory without link.json is not an instance.
	if err := os.MkdirAll(filepath.Join(connectorRoot, "stale"), 0o700); err != nil {
		t.Fatal(err)
	}
	// The daemon's overlay names the tier and owner of the dev link; an
	// overlay of another runtime (stale enrollment) is ignored.
	stateRoot := t.TempDir()
	connectorStateRoot = stateRoot
	t.Cleanup(func() { connectorStateRoot = layout.ConnectorStateDir })
	if err := os.MkdirAll(filepath.Join(stateRoot, "dev"), 0o700); err != nil {
		t.Fatal(err)
	}
	devContext := connector.LinkContext{Environment: "dev", Openedbot: "http://127.0.0.1:8790", Organization: connector.LinkOrganization{ID: "org-1", Name: "Acme", Slug: "acme"}, Owner: connector.LinkOwner{Email: "dev@example.com"}}
	if err := persistLinkContext(filepath.Join(stateRoot, "dev", "link-context.json"), "rt-dev", devContext, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := persistLinkContext(filepath.Join(stateRoot, "link-context.json"), "rt-old", devContext, time.Now()); err != nil {
		t.Fatal(err)
	}
	fake := exectest.NewFake().
		On("/usr/bin/systemctl is-active --quiet hermes-connector", exec.Result{ExitCode: 3}).
		On("/usr/bin/systemctl is-active --quiet hermes-connector@dev", exec.Result{})
	got := connectorStatus(context.Background(), systemd.Client{Runner: fake})
	want := []instanceStatus{
		{Name: "default", Unit: "hermes-connector.service", Active: false, Link: true, Openedbot: "https://console.openedbot.app", RuntimeID: "rt-prod", DeviceKey: false},
		{Name: "dev", Unit: "hermes-connector@dev.service", Active: true, Link: true, Openedbot: "http://127.0.0.1:8790", RuntimeID: "rt-dev", DeviceKey: true, Environment: "dev", Organization: "Acme", Owner: "dev@example.com"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	line := connectorStatusLine(term.Color{}, got[1])
	if !strings.Contains(line, "connector   dev      active=true link=true key=true openedbot=http://127.0.0.1:8790 runtime=rt-dev env=dev owner=dev@example.com") || strings.Contains(line, "tok") {
		t.Fatalf("line=%q", line)
	}
}

// Without --openedbot, link targets the production origin; an explicit one wins.
func TestLinkOriginDefaultsToProduction(t *testing.T) {
	if got := linkOrigin(""); got != "https://link.openedbot.app" {
		t.Fatalf("linkOrigin(\"\") = %q", got)
	}
	if got := linkOrigin("  "); got != DefaultOpenedbotOrigin {
		t.Fatalf("blank --openedbot = %q", got)
	}
	if got := linkOrigin("http://127.0.0.1:8790"); got != "http://127.0.0.1:8790" {
		t.Fatalf("explicit --openedbot overridden: %q", got)
	}
	if _, err := enroll.ParseOpenedbotURL(DefaultOpenedbotOrigin, false); err != nil {
		t.Fatalf("the default origin must be a valid https origin: %v", err)
	}
}
