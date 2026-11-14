package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func TestLabCrashRequiresPrivateEnrollmentAndLatestMatchingContext(t *testing.T) {
	redirectConnectorRoot(t)
	previousState := connectorStateRoot
	connectorStateRoot = filepath.Join(t.TempDir(), "state")
	t.Cleanup(func() { connectorStateRoot = previousState })
	instance := layout.ConnectorInstance("lab")
	if err := os.MkdirAll(instance.DirUnder(connectorRoot), 0o700); err != nil {
		t.Fatal(err)
	}
	link := LinkFile{Schema: 1, RuntimeID: labTestRuntime, Environment: "dev", LinkToken: "test-only", WSURL: "ws://127.0.0.1/link"}
	data, _ := json.Marshal(link)
	if err := os.WriteFile(linkPathOf(instance), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readLabCrashLink(instance); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(linkPathOf(instance), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readLabCrashLink(instance); err == nil {
		t.Fatal("public enrollment file accepted")
	}
	if err := os.Chmod(linkPathOf(instance), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := labCrashEnvironment(instance, labTestRuntime); err == nil {
		t.Fatal("missing latest environment accepted")
	}
	if err := os.MkdirAll(stateDirOf(instance), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(stateDirOf(instance), "link-context.json")
	for _, body := range []string{`{}`, `{"schema":1,"runtime_id":"another","openedbot_environment":"dev"}`, `broken`} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := labCrashEnvironment(instance, labTestRuntime); err == nil {
			t.Fatal("invalid latest environment accepted")
		}
	}
	context := linkContextFile{Schema: 1, RuntimeID: labTestRuntime, Environment: "dev"}
	data, _ = json.Marshal(context)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := labCrashEnvironment(instance, labTestRuntime); err != nil || got != "dev" {
		t.Fatalf("environment=%q err=%v", got, err)
	}
}

func TestLabCrashReceiptDirectoryRefusesSymlinks(t *testing.T) {
	options, deps, _ := labTestFixture(t)
	if err := os.Symlink(t.TempDir(), deps.StateDir); err != nil {
		t.Fatal(err)
	}
	if _, err := reserveLabCrash(deps.StateDir, deps.Owner, options); err == nil {
		t.Fatal("symlinked receipt directory accepted")
	}
}
