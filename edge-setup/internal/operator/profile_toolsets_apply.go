package operator

import (
	"context"
	_ "embed"
	"errors"
	"path/filepath"
	"slices"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

//go:embed profile_toolsets_apply.py
var profileToolsetsProgram []byte

// profileToolsetsApplier runs profile_toolsets_apply.py: both directions of a
// profile toolset batch in one Python process scoped to the profile's home,
// instead of one `hermes -p <slug> tools enable|disable` spawn per direction
// (~2.4 s each on the lab, 2026-11-02). The program refuses unless Hermes
// resolves the profile's own config.yaml. Any error makes the batch fall back
// on the CLI (profile_toolsets_batch.go); the read-back proves either way.
func profileToolsetsApplier(runner exec.Runner, runtimeRoot string, python func(args ...string) exec.Cmd) func(context.Context, string, []string, []string) error {
	return func(ctx context.Context, profile string, enable, disable []string) error {
		if runner == nil || python == nil || !filepath.IsAbs(runtimeRoot) || filepath.Clean(runtimeRoot) != runtimeRoot {
			return errors.New("the profile toolset program is unavailable")
		}
		if !profileSlugRe.MatchString(profile) || profile == "default" {
			return errors.New("the profile name is invalid")
		}
		for _, name := range slices.Concat(enable, disable) {
			if !toolsetRe.MatchString(name) {
				return errors.New("a toolset name is invalid")
			}
		}
		cmd := python("-")
		cmd.Stdin = append(slices.Clone(profileToolsetsProgram), '\n')
		cmd.Env = append(cmd.Env,
			"OPENEDBOT_TOOLSETS_ROOT="+runtimeRoot,
			"OPENEDBOT_TOOLSETS_PROFILE="+profile,
			"OPENEDBOT_TOOLSETS_ENABLE="+strings.Join(enable, ","),
			"OPENEDBOT_TOOLSETS_DISABLE="+strings.Join(disable, ","),
		)
		cmd.Timeout = ToolsetTimeout
		_, err := exec.Must(ctx, runner, cmd)
		return err
	}
}
