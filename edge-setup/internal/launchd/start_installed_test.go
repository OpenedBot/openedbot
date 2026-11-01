package launchd

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

func TestStartInstalledPreservesExactPlistAndOtherJobs(t *testing.T) {
	r := exectest.NewFake()
	c := newTestClient(t, t.TempDir(), "blue", r)
	if err := os.MkdirAll(filepath.Dir(c.PlistPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	old := []byte("private old definition fixture distinct from RenderPlist")
	if err := os.WriteFile(c.PlistPath(), old, 0o600); err != nil {
		t.Fatal(err)
	}
	r.On("/bin/launchctl bootstrap "+c.Domain()+" "+c.PlistPath(), exec.Result{})
	r.On("/bin/launchctl print "+c.Target(), exec.Result{Stdout: "state = waiting\n"})
	r.On("/bin/launchctl kickstart "+c.Target(), exec.Result{})
	if err := c.StartInstalled(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(c.PlistPath())
	if err != nil || !bytes.Equal(got, old) {
		t.Fatal("saved definition was overwritten")
	}
	if len(r.Calls) != 3 {
		t.Fatal("unexpected lifecycle commands")
	}
	assertCommand(t, r.Calls[0], "/bin/launchctl", "bootstrap", c.Domain(), c.PlistPath())
	assertCommand(t, r.Calls[1], "/bin/launchctl", "print", c.Target())
	assertCommand(t, r.Calls[2], "/bin/launchctl", "kickstart", c.Target())
}

func TestStartInstalledRefusesAbsentOrSymlinkedPlistBeforeLaunchctl(t *testing.T) {
	for _, link := range []bool{false, true} {
		r := exectest.NewFake()
		c := newTestClient(t, t.TempDir(), "blue", r)
		if err := os.MkdirAll(filepath.Dir(c.PlistPath()), 0o700); err != nil {
			t.Fatal(err)
		}
		if link {
			target := filepath.Join(c.cfg.HomeDir, "foreign")
			if err := os.WriteFile(target, []byte("foreign"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, c.PlistPath()); err != nil {
				t.Fatal(err)
			}
		}
		if err := c.StartInstalled(context.Background()); err == nil {
			t.Fatal("unsafe plist accepted")
		}
		if len(r.Calls) != 0 {
			t.Fatal("unsafe plist reached launchctl")
		}
	}
}
