// Package hostfacts collects what the tool needs to know about the host
// before deciding anything: distribution, architecture, virtualisation,
// cgroup version, primary address, and whether this session is remote.
package hostfacts

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

// Facts is the collected picture.
type Facts struct {
	Root              bool   `json:"root"`
	OSID              string `json:"os_id"`
	OSVersionID       int    `json:"os_version_id"`
	OSCodename        string `json:"os_codename"`
	Arch              string `json:"arch"`
	Virt              string `json:"virt"`
	CgroupV2          bool   `json:"cgroup_v2"`
	Hostname          string `json:"hostname"`
	PrimaryIP         string `json:"primary_ip"`
	PrimaryIPIsGlobal bool   `json:"primary_ip_is_global"`
	RebootRequired    bool   `json:"reboot_required"`
	VCPUs             int    `json:"vcpus"`
	MemTotalMB        int    `json:"mem_total_mb"`
	// SSHSession is true when the current process descends from sshd.
	SSHSession bool   `json:"ssh_session"`
	SSHClient  string `json:"ssh_client,omitempty"`
}

// Collector reads facts; Root lets tests point at a fixture tree.
type Collector struct {
	Runner exec.Runner
	Root   string
	Env    func(string) string
	EUID   int
	GOARCH string
}

// Default collects from the real host.
func Default(r exec.Runner) Collector {
	return Collector{Runner: r, Root: "/", Env: os.Getenv, EUID: os.Geteuid(), GOARCH: runtime.GOARCH}
}

func (c Collector) path(p string) string { return filepath.Join(c.Root, p) }

// Collect gathers the facts. Failures of optional probes are reported as
// unknown values, never as errors; only a broken os-release is fatal.
func (c Collector) Collect(ctx context.Context) (Facts, error) {
	f := Facts{Root: c.EUID == 0, Arch: c.GOARCH}
	osr, err := os.ReadFile(c.path("/etc/os-release"))
	if err != nil {
		return f, fmt.Errorf("read os-release: %w", err)
	}
	kv := parseOSRelease(string(osr))
	f.OSID = kv["ID"]
	f.OSCodename = kv["VERSION_CODENAME"]
	f.OSVersionID, _ = strconv.Atoi(strings.Split(kv["VERSION_ID"], ".")[0])
	if h, err := os.ReadFile(c.path("/etc/hostname")); err == nil {
		f.Hostname = strings.TrimSpace(string(h))
	}
	_, err = os.Stat(c.path("/sys/fs/cgroup/cgroup.controllers"))
	f.CgroupV2 = err == nil
	_, err = os.Stat(c.path("/var/run/reboot-required"))
	f.RebootRequired = err == nil
	f.VCPUs = runtime.NumCPU()
	if mem, err := os.ReadFile(c.path("/proc/meminfo")); err == nil {
		f.MemTotalMB = MemTotalMB(string(mem))
	}
	if c.Env != nil {
		if conn := c.Env("SSH_CONNECTION"); conn != "" {
			f.SSHSession = true
			if fields := strings.Fields(conn); len(fields) > 0 {
				f.SSHClient = fields[0]
			}
		}
	}
	if c.Runner != nil {
		if out, err := exec.Output(ctx, c.Runner, "/usr/bin/systemd-detect-virt"); err == nil {
			f.Virt = out
		} else {
			f.Virt = "none"
		}
		if ip := c.primaryIP(ctx); ip != nil {
			f.PrimaryIP = ip.String()
			f.PrimaryIPIsGlobal = IsGlobalUnicast(ip)
		}
	}
	return f, nil
}

func (c Collector) primaryIP(ctx context.Context) net.IP {
	out, err := exec.Output(ctx, c.Runner, "/usr/sbin/ip", "-j", "route", "get", "1.1.1.1")
	if err != nil {
		return nil
	}
	var routes []struct {
		PrefSrc string `json:"prefsrc"`
	}
	if err := json.Unmarshal([]byte(out), &routes); err != nil || len(routes) == 0 {
		return nil
	}
	return net.ParseIP(routes[0].PrefSrc)
}

// IsGlobalUnicast reports whether ip is a publicly routable unicast address:
// not private, loopback, link-local, CGNAT, documentation or multicast.
func IsGlobalUnicast(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	for _, cidr := range []string{"100.64.0.0/10", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "198.18.0.0/15", "0.0.0.0/8", "2001:db8::/32", "fc00::/7"} {
		_, n, _ := net.ParseCIDR(cidr)
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

// MemTotalMB parses /proc/meminfo.
func MemTotalMB(meminfo string) int {
	for _, line := range strings.Split(meminfo, "\n") {
		if v, ok := strings.CutPrefix(line, "MemTotal:"); ok {
			fields := strings.Fields(v)
			if len(fields) > 0 {
				kb, _ := strconv.Atoi(fields[0])
				return kb / 1024
			}
		}
	}
	return 0
}

func parseOSRelease(s string) map[string]string {
	kv := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		kv[k] = strings.Trim(v, `"`)
	}
	return kv
}

// SupportsRuntime reports whether the minimal runtime (base packages, uv
// managed Python, loopback gateway, connector) is supported. The floor is
// systemd 250 for LoadCredentialEncrypted and systemd-creds, which seal the
// connector device key: Debian 12 ships 252, Ubuntu 24.04 ships 255, Ubuntu
// 22.04 ships 249 and is refused.
func (f Facts) SupportsRuntime() bool {
	return (f.OSID == "debian" && f.OSVersionID >= 12) || (f.OSID == "ubuntu" && f.OSVersionID >= 24)
}

// SupportsHostProtections reports whether the opt-in protections are
// supported. They stay on Debian 13: the Docker pins are trixie builds, the
// quarantined cloud account is `debian`, and the UFW, PAM and
// unattended-upgrades baselines were proven there only.
func (f Facts) SupportsHostProtections() bool {
	return f.OSID == "debian" && f.OSVersionID >= 13
}

// Preflight lists why the host cannot be provisioned; empty means go.
func (f Facts) Preflight() []string {
	return f.PreflightFor(false, nil)
}

// PreflightFor validates the mandatory runtime host and applies optional
// requirements only for the features the operator selected. protections
// names every selected opt-in feature, sandbox included.
func (f Facts) PreflightFor(sandbox bool, protections []string) []string {
	var problems []string
	if !f.Root {
		problems = append(problems, "must run as root")
	}
	if !f.SupportsRuntime() {
		problems = append(problems, fmt.Sprintf("Debian 12 or later, or Ubuntu 24.04 or later, is required (found %s %d)", f.OSID, f.OSVersionID))
	} else if len(protections) > 0 && !f.SupportsHostProtections() {
		problems = append(problems, fmt.Sprintf("%s require Debian 13 or later (found %s %d); run up without them on this host", strings.Join(protections, ", "), f.OSID, f.OSVersionID))
	}
	if f.Arch != "amd64" && f.Arch != "arm64" {
		problems = append(problems, "unsupported architecture "+f.Arch)
	}
	if sandbox && !f.CgroupV2 {
		problems = append(problems, "cgroup v2 is required for the rootless sandbox")
	}
	return problems
}
