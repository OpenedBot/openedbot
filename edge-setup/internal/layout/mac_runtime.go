package layout

import (
	"path/filepath"

	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

// MacRuntimePaths is the dedicated edge-setup-managed runtime. It never uses
// or resets the invoking user's separate ~/.hermes installation.
type MacRuntimePaths struct {
	ConnectorHostPaths
	AppRoot       string
	RuntimeRoot   string
	InstallDir    string
	VenvBin       string
	NodeBin       string
	Probe         string
	OAuthProbe    string
	RestartMarker string
	Installer     string
}

func MacRuntime(home string) (MacRuntimePaths, error) {
	c, err := ConnectorPaths("darwin", home)
	if err != nil {
		return MacRuntimePaths{}, err
	}
	root := filepath.Dir(c.ToolConfig)
	runtime := filepath.Dir(c.RuntimeEnv)
	// A versioned checkout is never moved after its venv is built: generated
	// entry points contain absolute paths. It also leaves an older release
	// available while a new one is prepared before switching the gateway.
	install := filepath.Join(root, "releases", pins.HermesInstallerCommit, "hermes-agent")
	return MacRuntimePaths{ConnectorHostPaths: c, AppRoot: root, RuntimeRoot: runtime,
		InstallDir: install, VenvBin: filepath.Join(install, "venv", "bin"),
		NodeBin: filepath.Join(root, "node", pins.NodeVersion, "bin"),
		Probe:   filepath.Join(root, "bin", "operator_probe.py"), OAuthProbe: filepath.Join(root, "bin", "operator_mcp_oauth.py"),
		RestartMarker: filepath.Join(root, "gateway-restart-pending"), Installer: filepath.Join(root, "hermes-install.sh")}, nil
}
