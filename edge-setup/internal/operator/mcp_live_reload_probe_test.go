package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

// The probe reports `mcpLiveReload` only when BOTH upstream pieces are
// installed (the gateway's reconcile chore and the reconcile itself), read
// from their source files: it never imports the gateway package to find out.
func TestInventoryProbeReportsMCPLiveReloadFromTheInstalledSources(t *testing.T) {
	code := `import os, sys, tempfile
root = tempfile.mkdtemp()
def write(path, text):
    full = os.path.join(root, *path.split("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, "w").write(text)
write("gateway/__init__.py", "raise RuntimeError('the probe must not import the gateway package')\n")
write("tools/__init__.py", "raise RuntimeError('the probe must not import tools')\n")
sys.path.insert(0, root)
scope = {"__name__": "mcp_live_reload_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
supported = scope["mcp_live_reload_supported"]

assert supported() is False, "no source files yet"
write("gateway/run_profile_reconcile.py", "def _mcp_config_reconciler(runner=None):\n    pass\n")
assert supported() is False, "the reconcile itself is missing"
write("tools/mcp_tool_discovery.py", "def discover_mcp_tools():\n    pass\n")
assert supported() is False, "an older discovery module without the reconcile"
write("tools/mcp_tool_discovery.py", "def reconcile_mcp_servers_with_config() -> dict:\n    return {}\n")
assert supported() is True
assert "gateway" not in sys.modules and "tools" not in sys.modules
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("mcp live reload detection: %v\n%s", err, output)
	}
}
