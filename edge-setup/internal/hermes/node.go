package hermes

import (
	"context"
	"fmt"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

// nodeCommands are the three names the runtime resolves on PATH.
var nodeCommands = []string{"node", "npm", "npx"}

// installNode lays down the pinned Node tree the runtime's bridges need (the
// WhatsApp Baileys bridge, the Photon sidecar) and puts node, npm and npx on
// the PATH of the gateway unit.
//
// Two reasons it is installed here rather than left to the runtime. The
// upstream adapter refuses to start at all without a Node
// (`whatsapp_node_missing`), and when it does find none it scrapes nodejs.org
// and writes its own tree under HERMES_HOME, which the service user can then
// rewrite: the interpreter the gateway executes would live in a directory the
// gateway itself can modify. This tree is root-owned, checksum-pinned, and
// re-downloaded only when the pin changes.
//
// The caller treats a failure as a warning: a client who runs no Node
// platform must not lose an installation because nodejs.org is unreachable.
func (i *Installer) installNode(ctx context.Context) (bool, error) {
	if i.nodeVersion(ctx) == pins.NodeVersion {
		return false, i.linkNode(ctx)
	}
	archive := layout.NodeArchivePath(i.Arch.NodeTarget)
	if err := i.Download.Fetch(ctx, pins.NodeArchiveURL(i.Arch), archive, download.SHA256, i.Arch.NodeArchiveSHA256, 0o644, fsx.Root); err != nil {
		return false, err
	}
	if err := fsx.EnsureDir(layout.NodeRoot, 0o755, fsx.Root); err != nil {
		return false, err
	}
	if _, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: "/usr/bin/tar", Args: nodeExtractArgs(archive)}); err != nil {
		return false, err
	}
	if err := i.ownRoot(ctx, layout.NodeRoot); err != nil {
		return false, err
	}
	if got := i.nodeVersion(ctx); got != pins.NodeVersion {
		return false, fmt.Errorf("unexpected installed Node: %q, want %s", got, pins.NodeVersion)
	}
	if err := i.linkNode(ctx); err != nil {
		return false, err
	}
	i.Log("Node %s installed at %s for the runtime's bridges", pins.NodeVersion, layout.NodeRoot)
	return true, nil
}

// nodeExtractArgs unpacks the release over the managed tree, dropping the
// version directory the archive carries.
func nodeExtractArgs(archive string) []string {
	return []string{"-xJf", archive, "-C", layout.NodeRoot, "--strip-components=1"}
}

// nodeVersion is what the managed interpreter answers, or "" when there is
// none: an absent Node is a state to install, never an error.
func (i *Installer) nodeVersion(ctx context.Context) string {
	res, err := i.Runner.Run(ctx, exec.Cmd{Path: layout.NodeBin + "/node", Args: []string{"--version"}})
	if err != nil || res.ExitCode != 0 {
		return ""
	}
	return strings.TrimSpace(res.Stdout)
}

// linkNode publishes the three commands on the PATH the gateway unit carries
// and the one `shutil.which` reads, without exposing the rest of the tree.
func (i *Installer) linkNode(ctx context.Context) error {
	for _, name := range nodeCommands {
		if _, err := exec.Must(ctx, i.Runner, exec.Cmd{
			Path: "/bin/ln",
			Args: []string{"-sfn", layout.NodeBin + "/" + name, "/usr/local/bin/" + name},
		}); err != nil {
			return err
		}
	}
	return nil
}
