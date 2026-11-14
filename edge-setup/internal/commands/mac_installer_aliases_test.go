package commands

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/reset"
)

func TestMacInstallerAliasPathsAreScopedToCompatibilityNames(t *testing.T) {
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		filepath.Join(paths.AppRoot, "bin", "hermes-setup"),
		filepath.Join(home, ".local", "bin", "edge-setup"),
		filepath.Join(home, ".local", "bin", "hermes-setup"),
	}
	if got := macInstallerAliasPaths(home, paths); !reflect.DeepEqual(got, want) {
		t.Fatalf("installer aliases=%v, want %v", got, want)
	}
}

func TestMacInstallerAliasesRemoveOnlyOwnedExactTargets(t *testing.T) {
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	paths, err := layout.MacRuntime(home)
	if err != nil {
		t.Fatal(err)
	}
	aliases := macInstallerAliasPaths(home, paths)
	for _, dir := range []string{filepath.Dir(aliases[0]), filepath.Join(home, ".local"), filepath.Dir(aliases[1])} {
		macResetTestMkdir(t, dir)
	}
	macResetTestWrite(t, paths.ExecutablePath, "edge-setup binary", 0o700)
	macResetTestWrite(t, filepath.Join(home, "other-target"), "foreign target", 0o600)
	if err := os.Symlink(paths.ExecutablePath, aliases[0]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(aliases[1], []byte("user command"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(home, "other-target"), aliases[2]); err != nil {
		t.Fatal(err)
	}

	if err := inspectMacInstallerAliases(home, paths); err != nil {
		t.Fatalf("inspect preserved aliases: %v", err)
	}
	if err := removeMacInstallerAliases(home, paths); err != nil {
		t.Fatalf("remove owned alias: %v", err)
	}
	if _, err := os.Lstat(aliases[0]); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned alias remains or cannot be inspected: %v", err)
	}
	if got, err := os.ReadFile(aliases[1]); err != nil || string(got) != "user command" {
		t.Fatalf("regular user command changed: data=%q err=%v", got, err)
	}
	if got, err := os.Readlink(aliases[2]); err != nil || got != filepath.Join(home, "other-target") {
		t.Fatalf("foreign-target symlink changed: target=%q err=%v", got, err)
	}
	for _, dir := range []string{filepath.Dir(aliases[0]), filepath.Join(home, ".local"), filepath.Dir(aliases[1])} {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			t.Errorf("alias parent %q was removed or changed: info=%v err=%v", dir, info, err)
		}
	}
}

func TestResetMacRuntimeRemovesInstallerAliasesAndKeepsLocalBin(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
	aliases := macResetTestCreateInstallerAliases(t, f.home, f.paths)
	keep := filepath.Join(f.home, ".local", "bin", "keep")
	macResetTestWrite(t, keep, "user command", 0o700)

	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps()); err != nil {
		t.Fatalf("reset: %v", err)
	}
	for _, alias := range aliases[1:] {
		if _, err := os.Lstat(alias); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("installer alias %q remains or cannot be inspected: %v", alias, err)
		}
	}
	if got, err := os.ReadFile(keep); err != nil || string(got) != "user command" {
		t.Fatalf("unrelated ~/.local/bin command changed: data=%q err=%v", got, err)
	}
	if info, err := os.Stat(filepath.Join(f.home, ".local", "bin")); err != nil || !info.IsDir() {
		t.Fatalf("reset removed the user's local bin directory: info=%v err=%v", info, err)
	}
	if data, err := os.ReadFile(f.paths.RuntimeEnv); err != nil || string(data) != "runtime credential fixture" {
		t.Fatalf("normal reset did not retain runtime data: data=%q err=%v", data, err)
	}
}

func TestResetMacRuntimePlanLeavesInstallerAliasesUntouched(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
	aliases := macResetTestCreateInstallerAliases(t, f.home, f.paths)
	before := macResetTestSnapshot(t, f.home)
	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{Plan: true}, f.deps()); err != nil {
		t.Fatalf("plan: %v", err)
	}
	if f.tracker.stops != 0 || len(f.keys.removed) != 0 {
		t.Fatal("plan stopped a service or removed a key")
	}
	if after := macResetTestSnapshot(t, f.home); !reflect.DeepEqual(after, before) {
		t.Fatal("plan changed the filesystem containing installer aliases")
	}
	for _, alias := range aliases {
		if target, err := os.Readlink(alias); err != nil || target != f.paths.ExecutablePath {
			t.Errorf("plan changed alias %q: target=%q err=%v", alias, target, err)
		}
	}
}

func TestResetMacRuntimeRejectsInstallerAliasParentSymlinkBeforeMutation(t *testing.T) {
	f := newMacResetRuntimeFixture(t, true, []layout.ConnectorInstance{"dev"}, []layout.ConnectorInstance{"dev"}, nil, nil)
	target := t.TempDir()
	macResetTestWrite(t, filepath.Join(target, "keep"), "outside home", 0o600)
	if err := os.Symlink(target, filepath.Join(f.home, ".local")); err != nil {
		t.Fatal(err)
	}
	before := macResetTestSnapshot(t, f.home)
	if err := resetMacRuntime(context.Background(), f.home, f.paths, reset.Options{}, f.deps()); err == nil {
		t.Fatal("reset accepted a symlink in the installer alias parent path")
	}
	if f.tracker.stops != 0 || len(f.keys.removed) != 0 || f.keys.reads != 0 || f.registeredCalls != 0 {
		t.Fatalf("unsafe alias parent reached dependencies or mutations: stops=%d key removals=%v key reads=%d inventory reads=%d",
			f.tracker.stops, f.keys.removed, f.keys.reads, f.registeredCalls)
	}
	if after := macResetTestSnapshot(t, f.home); !reflect.DeepEqual(after, before) {
		t.Fatal("reset changed home files after rejecting the alias parent")
	}
	if data, err := os.ReadFile(filepath.Join(target, "keep")); err != nil || string(data) != "outside home" {
		t.Fatalf("symlink target changed: data=%q err=%v", data, err)
	}
}

func macResetTestCreateInstallerAliases(t *testing.T, home string, paths layout.MacRuntimePaths) []string {
	t.Helper()
	aliases := macInstallerAliasPaths(home, paths)
	for _, dir := range []string{filepath.Dir(aliases[0]), filepath.Join(home, ".local"), filepath.Dir(aliases[1])} {
		macResetTestMkdir(t, dir)
	}
	macResetTestWrite(t, paths.ExecutablePath, "edge-setup binary", 0o700)
	for _, alias := range aliases {
		if err := os.Symlink(paths.ExecutablePath, alias); err != nil {
			t.Fatal(err)
		}
	}
	return aliases
}
