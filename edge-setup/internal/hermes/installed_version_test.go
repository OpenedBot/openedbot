package hermes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

func writeStamp(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "install-stamp.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestInstalledVersionReadsTheStampWrittenByUp(t *testing.T) {
	dir := t.TempDir()
	if err := writeInstallStamp(filepath.Join(dir, "install-stamp.json"), fsx.Current()); err != nil {
		t.Fatal(err)
	}
	if got := InstalledVersion(dir); got != pins.HermesVersion {
		t.Fatalf("InstalledVersion = %q, want %q", got, pins.HermesVersion)
	}
}

func TestInstalledVersionIsTheStampNotThePin(t *testing.T) {
	dir := t.TempDir()
	writeStamp(t, dir, `{"schemaVersion":2,"displayVersion":"0.19.0","baseVersion":"0.19.0"}`)
	if got := InstalledVersion(dir); got != "0.19.0" {
		t.Fatalf("InstalledVersion = %q, want the stamped 0.19.0", got)
	}
}

func TestInstalledVersionFallsBackToBaseVersion(t *testing.T) {
	dir := t.TempDir()
	writeStamp(t, dir, `{"displayVersion":"","baseVersion":"0.21.1"}`)
	if got := InstalledVersion(dir); got != "0.21.1" {
		t.Fatalf("InstalledVersion = %q, want 0.21.1", got)
	}
}

func TestInstalledVersionAnnouncesNothingWithoutAUsableStamp(t *testing.T) {
	cases := map[string]func(t *testing.T, dir string){
		"missing":   func(t *testing.T, dir string) {},
		"corrupt":   func(t *testing.T, dir string) { writeStamp(t, dir, `{"displayVersion":`) },
		"empty":     func(t *testing.T, dir string) { writeStamp(t, dir, ``) },
		"no field":  func(t *testing.T, dir string) { writeStamp(t, dir, `{"schemaVersion":2}`) },
		"free text": func(t *testing.T, dir string) { writeStamp(t, dir, `{"displayVersion":"latest; rm -rf /"}`) },
		"too long": func(t *testing.T, dir string) {
			writeStamp(t, dir, `{"displayVersion":"1.2.3-`+strings.Repeat("a", 40)+`"}`)
		},
		"directory": func(t *testing.T, dir string) {
			if err := os.Mkdir(filepath.Join(dir, "install-stamp.json"), 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"symlink": func(t *testing.T, dir string) {
			target := filepath.Join(t.TempDir(), "elsewhere.json")
			if err := os.WriteFile(target, []byte(`{"displayVersion":"9.9.9"}`), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(dir, "install-stamp.json")); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, prepare := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			prepare(t, dir)
			if got := InstalledVersion(dir); got != "" {
				t.Fatalf("InstalledVersion = %q, want no version (never the pin %s)", got, pins.HermesVersion)
			}
		})
	}
}
