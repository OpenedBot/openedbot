package layout

import (
	"path/filepath"
)

// MacNamespace names everything edge-setup owns in one macOS user account:
// its private directory, coordination lock, LaunchAgent labels, logs and
// keychain service. Paths are relative to the user's home.
type MacNamespace struct {
	AppRoot         string
	Lock            string
	LabelPrefix     string
	Logs            string
	KeychainService string
}

// MacCurrent follows the desktop app's reverse-DNS convention
// (app.openedbot.desktop). Its lock sits beside the private directory so it
// survives the directory's removal by reset.
var MacCurrent = MacNamespace{
	AppRoot:         filepath.Join("Library", "Application Support", "app.openedbot.edge-setup"),
	Lock:            filepath.Join("Library", "Application Support", ".app.openedbot.edge-setup.lock"),
	LabelPrefix:     "app.openedbot.edge-setup.",
	Logs:            filepath.Join("Library", "Logs", "app.openedbot.edge-setup"),
	KeychainService: "app.openedbot.edge-setup.device-key",
}

// MacLegacy is the namespace releases before the product rename installed.
// It is only read to move an existing installation into MacCurrent once,
// and to let reset and uninstall remove whatever is left of it.
var MacLegacy = MacNamespace{
	AppRoot:         filepath.Join("Library", "Application Support", "OpenHermesBot", "edge-setup"),
	Lock:            filepath.Join("Library", "Application Support", "OpenHermesBot", ".edge-setup.lock"),
	LabelPrefix:     "com.openhermesbot.edge-setup.",
	Logs:            filepath.Join("Library", "Logs", "OpenHermesBot"),
	KeychainService: "com.openhermesbot.edge-setup.device-key",
}

func (n MacNamespace) AppRootIn(home string) string { return filepath.Join(home, n.AppRoot) }
func (n MacNamespace) LockIn(home string) string    { return filepath.Join(home, n.Lock) }
func (n MacNamespace) LogsIn(home string) string    { return filepath.Join(home, n.Logs) }

// IsLegacy reports whether n is the pre-rename namespace.
func (n MacNamespace) IsLegacy() bool { return n == MacLegacy }
