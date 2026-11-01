package hermes

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

// MacGit checks the selected developer tools before invoking Git. Running
// the /usr/bin/git shim without installed tools can open an install dialog.
// This function neither installs tools nor changes xcode-select settings.
func MacGit(ctx context.Context, r exec.Runner) (string, error) {
	if r == nil {
		return "", errors.New("macOS Git inspection is unavailable")
	}
	selected, err := r.Run(ctx, exec.Cmd{Path: "/usr/bin/xcode-select", Args: []string{"--print-path"}, Timeout: 10 * time.Second})
	if err != nil || selected.ExitCode != 0 || strings.TrimSpace(selected.Stderr) != "" {
		return "", errors.New("select installed Xcode command-line tools before preparing this runtime")
	}
	root := strings.TrimSpace(selected.Stdout)
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || strings.ContainsAny(root, "\x00\r\n") {
		return "", errors.New("selected developer tools path is invalid")
	}
	git := filepath.Join(root, "usr", "bin", "git")
	info, err := os.Stat(git)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return "", errors.New("selected developer tools do not contain an executable Git")
	}
	version, err := r.Run(ctx, exec.Cmd{Path: git, Args: []string{"--version"}, Timeout: 10 * time.Second})
	if err != nil || version.ExitCode != 0 || strings.TrimSpace(version.Stderr) != "" || !strings.HasPrefix(strings.TrimSpace(version.Stdout), "git version ") {
		return "", errors.New("selected developer tools Git could not be verified")
	}
	return git, nil
}
