package docker

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/render"
)

func nfInstaller(t *testing.T, f *exectest.Fake, lxc bool, modules string) *Installer {
	t.Helper()
	dir := t.TempDir()
	proc := filepath.Join(dir, "modules")
	if err := os.WriteFile(proc, []byte(modules), 0o644); err != nil {
		t.Fatal(err)
	}
	return &Installer{Runner: f, LXC: lxc, ModulesLoad: filepath.Join(dir, "hermes-docker.conf"), ProcModules: proc}
}

func TestEnsureNFTablesLoadsAndPersistsTheModule(t *testing.T) {
	f := exectest.NewFake()
	f.On("/usr/sbin/modprobe nf_tables", exec.Result{})
	i := nfInstaller(t, f, false, "overlay 151552 0 - Live 0x0000000000000000\n")
	if err := i.ensureNFTables(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !f.Ran("/usr/sbin/modprobe nf_tables") {
		t.Fatalf("nf_tables must be loaded before the rootless setup: %v", f.Commands())
	}
	want, _ := render.DockerModulesLoad()
	got, err := os.ReadFile(i.ModulesLoad)
	if err != nil || string(got) != want {
		t.Fatalf("modules-load.d entry %q (%v), want %q", got, err, want)
	}
}

func TestEnsureNFTablesIsIdempotentOnceLoaded(t *testing.T) {
	f := exectest.NewFake()
	i := nfInstaller(t, f, false, "nf_tables 372736 0 - Live 0x0000000000000000\n")
	for range 2 {
		if err := i.ensureNFTables(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.Calls) != 0 {
		t.Fatalf("a loaded module needs no modprobe: %v", f.Commands())
	}
	if _, err := os.Stat(i.ModulesLoad); err != nil {
		t.Fatalf("the module must still be persisted: %v", err)
	}
}

func TestEnsureNFTablesReportsAModprobeFailure(t *testing.T) {
	f := exectest.NewFake()
	f.On("/usr/sbin/modprobe nf_tables", exec.Result{ExitCode: 1, Stderr: "modprobe: FATAL: Module nf_tables not found"})
	i := nfInstaller(t, f, false, "")
	err := i.ensureNFTables(context.Background())
	if err == nil || !strings.Contains(err.Error(), "nf_tables kernel module") || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("modprobe failure must be explicit: %v", err)
	}
}

func TestEnsureNFTablesInLXCPointsAtTheHost(t *testing.T) {
	f := exectest.NewFake()
	f.On("/usr/sbin/modprobe nf_tables", exec.Result{ExitCode: 1, Stderr: "modprobe: FATAL: Module nf_tables not found in directory /lib/modules/6.8.12-4-pve"})
	i := nfInstaller(t, f, true, "")
	if err := i.ensureNFTables(context.Background()); err == nil || !strings.Contains(err.Error(), "Proxmox host") {
		t.Fatalf("LXC must be told to load the module on the host: %v", err)
	}
	if _, err := os.Stat(i.ModulesLoad); err == nil {
		t.Fatal("a container cannot load modules at boot: no modules-load.d entry")
	}
}

func TestModuleLoaded(t *testing.T) {
	p := filepath.Join(t.TempDir(), "modules")
	_ = os.WriteFile(p, []byte("nf_tables_set 1 0 - Live 0x0\nnf_tables 2 1 nf_tables_set, Live 0x0\n"), 0o644)
	if !ModuleLoaded(p, "nf_tables") || ModuleLoaded(p, "ip_tables") {
		t.Fatal("exact module name match expected")
	}
	if ModuleLoaded(filepath.Join(t.TempDir(), "absent"), "nf_tables") {
		t.Fatal("an unreadable /proc/modules proves nothing")
	}
}

func TestRootfulDaemonRunning(t *testing.T) {
	if !RootfulDaemonRunning("    0 systemd\n    0 dockerd\n  998 dockerd\n") {
		t.Fatal("uid-0 dockerd must be detected")
	}
	if RootfulDaemonRunning("    0 systemd\n  998 dockerd\n  998 containerd\n") {
		t.Fatal("rootless daemons are fine")
	}
}

func TestUpsertSubid(t *testing.T) {
	got := UpsertSubid("debian:100000:65536\nhermes:1:1\n", 300000, 65536)
	if got != "debian:100000:65536\nhermes:300000:65536\n" {
		t.Fatalf("%q", got)
	}
	got = UpsertSubid("", 10000, 55000)
	if got != "hermes:10000:55000\n" {
		t.Fatalf("%q", got)
	}
	i := &Installer{LXC: true}
	if s, c := i.Subid(); s+c > 65536 {
		t.Fatal("LXC range must fit the container uid space")
	}
}

func TestProofs(t *testing.T) {
	if err := RequireRootlessCgroupV2(`{"CgroupVersion":"2","SecurityOptions":["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]}`); err != nil {
		t.Fatal(err)
	}
	if err := RequireRootlessCgroupV2(`{"CgroupVersion":"1","SecurityOptions":["name=rootless"]}`); err == nil {
		t.Fatal("cgroup v1 must be refused")
	}
	if err := RequireCgroupLimits("67108864\n50000 100000\n32\n"); err != nil {
		t.Fatal(err)
	}
	if err := RequireCgroupLimits("max\nmax 100000\nmax\n"); err == nil || !strings.Contains(err.Error(), "delegation") {
		t.Fatalf("unlimited container must be refused: %v", err)
	}
}
