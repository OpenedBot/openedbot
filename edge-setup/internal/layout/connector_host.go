package layout

import (
	"errors"
	"path/filepath"
	"strings"
)

// ConnectorHostPaths selects only edge-setup's connector files. Linux keeps
// its installed namespace; macOS uses the invoking user's private app data.
type ConnectorHostPaths struct {
	ConnectorRoot  string
	StateRoot      string
	ToolConfig     string
	RuntimeEnv     string
	OperatorSocket string
	ExecutablePath string
}

func ConnectorPaths(goos, home string) (ConnectorHostPaths, error) {
	switch goos {
	case "linux":
		return ConnectorHostPaths{ConnectorRoot: ConnectorDir, StateRoot: ConnectorStateDir, ToolConfig: ToolConfig,
			RuntimeEnv: RuntimeEnv, OperatorSocket: OperatorSocket, ExecutablePath: ToolInstalledPath}, nil
	case "darwin":
		if !filepath.IsAbs(home) || filepath.Clean(home) != home || home == "/" || strings.ContainsAny(home, "\x00\r\n") {
			return ConnectorHostPaths{}, errors.New("macOS connector requires a clean absolute user home")
		}
		root := filepath.Join(home, "Library", "Application Support", "OpenHermesBot", "edge-setup")
		return ConnectorHostPaths{
			ConnectorRoot: filepath.Join(root, "connector"), StateRoot: filepath.Join(root, "connector-state"),
			ToolConfig: filepath.Join(root, "config.json"), RuntimeEnv: filepath.Join(root, "runtime", "runtime.env"),
			OperatorSocket: filepath.Join(root, "operator.sock"),
			ExecutablePath: filepath.Join(root, "bin", "edge-setup"),
		}, nil
	default:
		return ConnectorHostPaths{}, errors.New("connector service supports Linux and macOS only")
	}
}
