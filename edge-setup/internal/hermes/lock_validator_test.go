package hermes

import (
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const pypiOK = `[[package]]
name = "requests"
version = "1.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/r.tar.gz", hash = "sha256:aa" }
`

func runLockValidator(t *testing.T, lock string) (string, error) {
	t.Helper()
	python, err := osexec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	// The host runs the validator under the pinned interpreter
	// (pins.PythonVersion); tomllib needs 3.11+, so an older local python3
	// cannot stand in for it.
	if osexec.Command(python, "-c", "import tomllib").Run() != nil {
		t.Skip("python3 lacks tomllib (3.11+ required)")
	}
	path := filepath.Join(t.TempDir(), "uv.lock")
	if err := os.WriteFile(path, []byte(lock), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := osexec.Command(python, "-c", lockValidator, path).CombinedOutput()
	return string(out), err
}

func TestLockValidatorAcceptsPinnedGitHubSources(t *testing.T) {
	lock := pypiOK + `
[[package]]
name = "kittentts"
version = "0.8.1"
source = { url = "https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl" }
wheels = [{ url = "https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl", hash = "sha256:482a" }]

[[package]]
name = "misaki"
version = "0.9.4"
source = { git = "https://github.com/NousResearch/misaki.git?rev=f03fd2be7346952a83d3d4845c217fc7667f322d#f03fd2be7346952a83d3d4845c217fc7667f322d" }

[[package]]
name = "hermes-agent"
version = "0.0.0"
source = { editable = "." }
`
	if out, err := runLockValidator(t, lock); err != nil {
		t.Fatalf("pinned GitHub sources refused: %v %s", err, out)
	}
}

func TestLockValidatorRefusesUnpinnedOrForeignSources(t *testing.T) {
	cases := map[string]string{
		"git without rev":  `source = { git = "https://github.com/a/b.git" }`,
		"git short rev":    `source = { git = "https://github.com/a/b.git?rev=f03fd2b#f03fd2b" }`,
		"git rev mismatch": `source = { git = "https://github.com/a/b.git?rev=f03fd2be7346952a83d3d4845c217fc7667f322d#0000000000000000000000000000000000000000" }`,
		"git off github":   `source = { git = "https://gitlab.com/a/b.git?rev=f03fd2be7346952a83d3d4845c217fc7667f322d#f03fd2be7346952a83d3d4845c217fc7667f322d" }`,
		"url off github":   "source = { url = \"https://example.com/a/b/c.whl\" }\nwheels = [{ url = \"https://example.com/a/b/c.whl\", hash = \"sha256:aa\" }]",
		"url unhashed":     "source = { url = \"https://github.com/a/b/c.whl\" }\nwheels = [{ url = \"https://github.com/a/b/c.whl\" }]",
		"url plain http":   "source = { url = \"http://github.com/a/b/c.whl\" }\nwheels = [{ url = \"http://github.com/a/b/c.whl\", hash = \"sha256:aa\" }]",
		"path source":      `source = { path = "../evil" }`,
		"other registry":   "source = { registry = \"https://evil.example/simple\" }\nsdist = { url = \"https://evil.example/x.tar.gz\", hash = \"sha256:aa\" }",
		"pypi unhashed":    "source = { registry = \"https://pypi.org/simple\" }\nsdist = { url = \"https://files.pythonhosted.org/x.tar.gz\" }",
	}
	for name, body := range cases {
		lock := "[[package]]\nname = \"x\"\nversion = \"1\"\n" + body + "\n"
		out, err := runLockValidator(t, lock)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if !strings.Contains(out, "lock") {
			t.Errorf("%s: unexpected refusal text %q", name, out)
		}
	}
}
