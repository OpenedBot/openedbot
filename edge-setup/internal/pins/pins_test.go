package pins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestToolsetIsForbiddenSplitsRootAndProfile(t *testing.T) {
	if !ToolsetIsForbidden("memory", false) || !ToolsetIsForbidden("session_search", false) {
		t.Fatal("memory and session_search stay forbidden on the root")
	}
	if ToolsetIsForbidden("memory", true) || ToolsetIsForbidden("session_search", true) {
		t.Fatal("memory and session_search are allowed on a named profile")
	}
	if !ToolsetIsForbidden("cronjob", true) || !ToolsetIsForbidden("delegation", true) {
		t.Fatal("cronjob and delegation stay forbidden on a named profile")
	}
	if !ToolsetIsForbidden("cronjob", false) || !ToolsetIsForbidden("delegation", false) {
		t.Fatal("cronjob and delegation stay forbidden on the root")
	}
	root := append([]string{}, ForbiddenToolsets...)
	if len(root) != 4 {
		t.Fatalf("ForbiddenToolsets (runtime set) = %v", root)
	}
}

func TestDockerPackageNamesMatchTheSelections(t *testing.T) {
	got := strings.Join(DockerPackageNames(), " ")
	if got != "docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras" {
		t.Fatalf("held Docker packages = %s", got)
	}
}

// The Node pin is repeated verbatim: a bump is a deliberate edit in two
// places, and the checksums are the ones nodejs.org publishes for that
// release, never recomputed from a downloaded file.
func TestNodePinIsVerbatim(t *testing.T) {
	if NodeVersion != "v22.23.2" {
		t.Fatalf("NodeVersion = %s", NodeVersion)
	}
	want := map[string][2]string{
		"amd64": {"x64", "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"},
		"arm64": {"arm64", "fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8"},
	}
	for name, w := range want {
		a, ok := Arches[name]
		if !ok {
			t.Fatalf("no arch %s", name)
		}
		if a.NodeTarget != w[0] || a.NodeArchiveSHA256 != w[1] {
			t.Fatalf("%s: target=%s sha=%s", name, a.NodeTarget, a.NodeArchiveSHA256)
		}
		if got := NodeArchiveURL(a); got != "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-"+w[0]+".tar.xz" {
			t.Fatalf("%s url = %s", name, got)
		}
	}
}

// The forbidden toolsets are enforced on both sides of the connector link:
// here, and in openedbot's runtime-contract.ts. Both tests read the same
// manifest, and `make contract-check` compares the two copies byte for byte,
// so a toolset added on one side only fails before it ships.
func TestForbiddenToolsetsMatchTheSharedManifest(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "test", "golden", "forbidden-toolsets", "forbidden-toolsets.json"))
	if err != nil {
		t.Fatalf("shared forbidden-toolsets manifest: %v", err)
	}
	var manifest struct {
		AlwaysForbidden   []string `json:"alwaysForbidden"`
		ProfileRestricted []string `json:"profileRestricted"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if !slices.Equal(manifest.AlwaysForbidden, AlwaysForbiddenToolsets) {
		t.Fatalf("AlwaysForbiddenToolsets = %v, manifest = %v", AlwaysForbiddenToolsets, manifest.AlwaysForbidden)
	}
	if !slices.Equal(manifest.ProfileRestricted, ProfileRestrictedToolsets) {
		t.Fatalf("ProfileRestrictedToolsets = %v, manifest = %v", ProfileRestrictedToolsets, manifest.ProfileRestricted)
	}
}
