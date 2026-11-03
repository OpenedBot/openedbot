package hostfacts

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

func fixture(t *testing.T, osRelease string, cgroupV2 bool) string {
	t.Helper()
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "etc"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "etc", "os-release"), []byte(osRelease), 0o644)
	_ = os.WriteFile(filepath.Join(root, "etc", "hostname"), []byte("vps1\n"), 0o644)
	if cgroupV2 {
		_ = os.MkdirAll(filepath.Join(root, "sys", "fs", "cgroup"), 0o755)
		_ = os.WriteFile(filepath.Join(root, "sys", "fs", "cgroup", "cgroup.controllers"), []byte("cpu memory\n"), 0o644)
	}
	return root
}

const trixie = "ID=debian\nVERSION_ID=\"13\"\nVERSION_CODENAME=trixie\n"

func TestCollectDebian13(t *testing.T) {
	f := exectest.NewFake()
	f.On("/usr/bin/systemd-detect-virt", exec.Result{Stdout: "kvm\n"})
	f.On("/usr/sbin/ip -j route get 1.1.1.1", exec.Result{Stdout: `[{"dst":"1.1.1.1","gateway":"203.0.113.1","dev":"eth0","prefsrc":"9.9.9.9"}]`})
	c := Collector{Runner: f, Root: fixture(t, trixie, true), Env: func(k string) string {
		if k == "SSH_CONNECTION" {
			return "198.51.100.7 51234 9.9.9.9 22"
		}
		return ""
	}, EUID: 0, GOARCH: "amd64"}
	facts, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if facts.OSID != "debian" || facts.OSVersionID != 13 || facts.OSCodename != "trixie" || !facts.CgroupV2 || facts.Virt != "kvm" || facts.Hostname != "vps1" {
		t.Fatalf("%+v", facts)
	}
	if facts.PrimaryIP != "9.9.9.9" || !facts.PrimaryIPIsGlobal || !facts.SSHSession || facts.SSHClient != "198.51.100.7" {
		t.Fatalf("%+v", facts)
	}
	if p := facts.Preflight(); len(p) != 0 {
		t.Fatalf("preflight problems: %v", p)
	}
}

func TestPreflightRefusals(t *testing.T) {
	c := Collector{Root: fixture(t, "ID=ubuntu\nVERSION_ID=\"22.04\"\n", false), EUID: 1000, GOARCH: "riscv64"}
	facts, err := c.Collect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	p := facts.Preflight()
	if len(p) != 3 {
		t.Fatalf("expected 3 mandatory problems, got %v", p)
	}
	if p := facts.PreflightFor(true, []string{"sandbox"}); len(p) != 4 {
		t.Fatalf("sandbox preflight must add cgroup v2, got %v", p)
	}
}

func TestPreflightAcceptsUbuntuAndDebian12Runtime(t *testing.T) {
	for _, osRelease := range []string{
		"ID=ubuntu\nVERSION_ID=\"24.04\"\nVERSION_CODENAME=noble\n",
		"ID=debian\nVERSION_ID=\"12\"\nVERSION_CODENAME=bookworm\n",
	} {
		c := Collector{Root: fixture(t, osRelease, true), EUID: 0, GOARCH: "amd64"}
		facts, err := c.Collect(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if p := facts.Preflight(); len(p) != 0 {
			t.Fatalf("%q: minimal runtime must be accepted, got %v", osRelease, p)
		}
		p := facts.PreflightFor(false, []string{"firewall"})
		if len(p) != 1 || !strings.Contains(p[0], "firewall require Debian 13") {
			t.Fatalf("%q: opt-in protections must stay Debian 13 only, got %v", osRelease, p)
		}
	}
	c := Collector{Root: fixture(t, trixie, true), EUID: 0, GOARCH: "arm64"}
	facts, _ := c.Collect(context.Background())
	if p := facts.PreflightFor(true, []string{"firewall", "sandbox"}); len(p) != 0 {
		t.Fatalf("Debian 13 must accept opt-in protections, got %v", p)
	}
}

func TestHomelabAddressIsNotGlobal(t *testing.T) {
	f := exectest.NewFake()
	f.On("/usr/bin/systemd-detect-virt", exec.Result{ExitCode: 1, Stdout: "none\n"})
	f.On("/usr/sbin/ip -j route get 1.1.1.1", exec.Result{Stdout: `[{"prefsrc":"192.168.0.42"}]`})
	c := Collector{Runner: f, Root: fixture(t, trixie, true), EUID: 0, GOARCH: "arm64"}
	facts, _ := c.Collect(context.Background())
	if facts.PrimaryIPIsGlobal {
		t.Fatalf("%+v", facts)
	}
}

func TestIsGlobalUnicast(t *testing.T) {
	for ip, want := range map[string]bool{
		"9.9.9.9": true, "2a01:e0a::1": true,
		"10.0.0.1": false, "192.168.0.1": false, "172.16.0.1": false, "100.64.0.1": false,
		"127.0.0.1": false, "169.254.1.1": false, "192.0.2.10": false, "fd00::1": false, "fe80::1": false,
	} {
		if got := IsGlobalUnicast(net.ParseIP(ip)); got != want {
			t.Errorf("%s: %v", ip, got)
		}
	}
}

func TestMemTotalMB(t *testing.T) {
	if got := MemTotalMB("MemTotal:        8123456 kB\nMemFree:  1 kB\n"); got != 7933 {
		t.Fatalf("got %d", got)
	}
	if MemTotalMB("") != 0 {
		t.Fatal("empty")
	}
}
