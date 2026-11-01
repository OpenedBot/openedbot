package commands

import (
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// redirectConnectorRoot confines filesystem fixtures to the test directory.
// It does not select or invoke a native device-key store.
func redirectConnectorRoot(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	prevRoot, prevTPM, prevOwner := connectorRoot, tpmDevice, connectorOwner
	connectorRoot = filepath.Join(dir, "connector")
	tpmDevice = filepath.Join(dir, "no-tpm")
	connectorOwner = fsx.Current()
	t.Cleanup(func() { connectorRoot, tpmDevice, connectorOwner = prevRoot, prevTPM, prevOwner })
	return dir
}
