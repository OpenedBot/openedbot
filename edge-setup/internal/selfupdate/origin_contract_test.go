package selfupdate

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The retired GitHub releases repository went private: an anonymous download
// from it can only fail, and it is no longer the origin a host trusts. These
// files used to carry it as a default; one drifting back would silently
// restore a dead install or upgrade path. The owner match is case-sensitive:
// selfupdate.go names it in lower case to refuse it.
var retiredBase = []*regexp.Regexp{
	regexp.MustCompile(`MakFly/edge-setup-releases`),
	regexp.MustCompile(`(?i)github\.com/[\w.-]+/edge-setup-releases/releases`),
	regexp.MustCompile(`(?i)api\.github\.com/repos/[\w.-]+/edge-setup-releases`),
}

func retiredLines(text string) []string {
	var hits []string
	for _, line := range strings.Split(text, "\n") {
		for _, re := range retiredBase {
			if re.MatchString(line) {
				hits = append(hits, strings.TrimSpace(line))
				break
			}
		}
	}
	return hits
}

func TestRetiredBaseMatcher(t *testing.T) {
	for _, bad := range []string{
		`const DefaultBaseURL = "https://github.com/MakFly/edge-setup-releases/releases/latest/download"`,
		`BASE="https://github.com/OpenedBot/edge-setup-releases/releases/latest/download"`,
		`url = "https://api.github.com/repos/OpenedBot/edge-setup-releases/releases/latest"`,
	} {
		if len(retiredLines(bad)) != 1 {
			t.Errorf("not caught: %s", bad)
		}
	}
	for _, good := range []string{DefaultBaseURL, `strings.Contains(path, "/makfly/edge-setup-releases")`} {
		if len(retiredLines(good)) != 0 {
			t.Errorf("wrongly caught: %s", good)
		}
	}
}

func TestNoDefaultPointsAtTheRetiredGitHubBase(t *testing.T) {
	root := filepath.Join("..", "..")
	files := []string{"internal/selfupdate/selfupdate.go", "Makefile", "packaging/nfpm.yaml", "scripts/publish-r2.sh"}
	workflows, _ := filepath.Glob(filepath.Join(root, ".github", "workflows", "*.yml"))
	for _, w := range workflows {
		rel, _ := filepath.Rel(root, w)
		files = append(files, rel)
	}
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		for _, hit := range retiredLines(string(data)) {
			t.Errorf("%s points at the retired GitHub releases repository: %s", f, hit)
		}
	}
	src, err := os.ReadFile("selfupdate.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), `"https://releases.openedbot.app/edge-setup"`) {
		t.Error("selfupdate.go no longer carries the public origin as DefaultBaseURL")
	}
}
