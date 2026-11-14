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
		return MacConnectorPaths(MacCurrent, home)
	default:
		return ConnectorHostPaths{}, errors.New("connector service supports Linux and macOS only")
	}
}

// MacConnectorPaths resolves the connector files of one macOS namespace.
func MacConnectorPaths(ns MacNamespace, home string) (ConnectorHostPaths, error) {
	if !filepath.IsAbs(home) || filepath.Clean(home) != home || home == "/" || strings.ContainsAny(home, "\x00\r\n") {
		return ConnectorHostPaths{}, errors.New("macOS connector requires a clean absolute user home")
	}
	if ns != MacCurrent && ns != MacLegacy {
		return ConnectorHostPaths{}, errors.New("unknown macOS namespace")
	}
	root := ns.AppRootIn(home)
	return ConnectorHostPaths{
		ConnectorRoot: filepath.Join(root, "connector"), StateRoot: filepath.Join(root, "connector-state"),
		ToolConfig: filepath.Join(root, "config.json"), RuntimeEnv: filepath.Join(root, "runtime", "runtime.env"),
		OperatorSocket: filepath.Join(root, "operator.sock"),
		ExecutablePath: filepath.Join(root, "bin", "edge-setup"),
	}, nil
}
