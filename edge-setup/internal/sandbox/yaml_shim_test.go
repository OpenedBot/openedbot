package sandbox

import (
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The embedded config scripts must run on a Hermes venv that ships PyYAML
// (0.20.x) and on one that only ships ruamel.yaml (0.22.x). The test hides
// PyYAML to force the ruamel branch when ruamel is importable.
func TestContractScriptsRunWithoutPyYAML(t *testing.T) {
	python, err := osexec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	if osexec.Command(python, "-c", "import ruamel.yaml").Run() != nil {
		t.Skip("ruamel.yaml not available")
	}
	dir := t.TempDir()
	config := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(config, []byte("gateway:\n  multiplex_profiles: true\nplatform_toolsets:\n  api_server: [web]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	hide := "import sys; sys.modules['yaml'] = None\n"
	edit, _ := os.ReadFile("contract_edit.py")
	out, err := osexec.Command(python, "-c", hide+string(edit), config, `["web","todo"]`).CombinedOutput()
	if err != nil || !strings.Contains(string(out), "changed") {
		t.Fatalf("contract_edit without PyYAML: %v %s", err, out)
	}
	probe, _ := os.ReadFile("contract_probe.py")
	out, err = osexec.Command(python, "-c", hide+string(probe), config, `["web","todo"]`).CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "ok" {
		t.Fatalf("contract_probe without PyYAML: %v %s", err, out)
	}
	written, _ := os.ReadFile(config)
	if !strings.HasPrefix(string(written), "gateway:") {
		t.Fatalf("key order not kept:\n%s", written)
	}
}
