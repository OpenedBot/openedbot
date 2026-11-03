// Package docker installs a rootless Docker daemon owned by the Hermes
// service user. Design choice, not convenience: the runtime keeps neither
// sudo nor the docker group, so the socket it talks to is its own daemon in
// a user namespace: root inside a sandbox is an unprivileged uid on the
// host. The rootful daemon the package ships never runs here.
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/render"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Subid range. System users get no automatic range; the cloud-init user
// typically owns 100000-165535, so start well above. Inside an unprivileged
// LXC the uid space stops at 65535: the LXC range fits under it.
const (
	SubidStart    = 300000
	SubidCount    = 65536
	LXCSubidStart = 10000
	LXCSubidCount = 55000
)

const (
	keyringPath = "/etc/apt/keyrings/docker.asc"
	sourcesPath = "/etc/apt/sources.list.d/docker.sources"
	delegateDir = "/etc/systemd/system/user@.service.d"
	delegatePth = delegateDir + "/delegate.conf"
	rootfulSock = "/var/run/docker.sock"
)

var rootfulUnits = []string{"docker.socket", "docker.service", "containerd.service"}

// Installer carries the dependencies of the docker phase.
type Installer struct {
	Runner   exec.Runner
	Apt      apt.Client
	Accounts account.Client
	Download download.Client
	Systemd  systemd.Client
	Arch     pins.Arch
	Codename string
	// LXC selects the container-sized subid range.
	LXC bool
	// Paths, overridable for tests.
	ModulesLoad, ProcModules string
}

// New wires an installer.
func New(r exec.Runner, arch pins.Arch, codename string, lxc bool) *Installer {
	return &Installer{
		Runner: r, Apt: apt.New(r), Accounts: account.New(r), Download: download.Default(), Systemd: systemd.Client{Runner: r},
		Arch: arch, Codename: codename, LXC: lxc,
		ModulesLoad: layout.DockerModulesLoad, ProcModules: "/proc/modules",
	}
}

// Subid returns the range for this host.
func (i *Installer) Subid() (int, int) {
	if i.LXC {
		return LXCSubidStart, LXCSubidCount
	}
	return SubidStart, SubidCount
}

// RootlessEnv is what a `systemctl --user` / `docker` invocation needs when
// it does not come from a login session.
func RootlessEnv(uid int) []string {
	return []string{
		"HOME=/home/" + layout.ServiceUser,
		fmt.Sprintf("XDG_RUNTIME_DIR=/run/user/%d", uid),
		fmt.Sprintf("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%d/bus", uid),
		fmt.Sprintf("DOCKER_HOST=unix:///run/user/%d/docker.sock", uid),
		"PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
	}
}

// AsRootless runs a command as the service user with the rootless env.
func AsRootless(uid int, path string, args ...string) exec.Cmd {
	return account.AsUser(layout.ServiceUser, RootlessEnv(uid), path, args...)
}

// Run installs and proves the rootless daemon; returns the service uid.
func (i *Installer) Run(ctx context.Context) (int, error) {
	info, err := i.Accounts.Get(ctx, layout.ServiceUser)
	if err != nil {
		return 0, err
	}
	if info == nil {
		return 0, errors.New("the service account does not exist yet; run the runtime phase first")
	}
	if err := i.refuseRootfulUsage(ctx); err != nil {
		return 0, err
	}
	if err := i.Apt.Install(ctx, pins.DockerRootlessPrereqs...); err != nil {
		return 0, err
	}
	if err := i.installRepository(ctx); err != nil {
		return 0, err
	}
	if err := i.Apt.Require(ctx, pins.DockerPackages()...); err != nil {
		return 0, err
	}
	if err := i.Apt.InstallHeld(ctx, pins.DockerPackages()...); err != nil {
		return 0, err
	}
	if err := i.maskRootful(ctx); err != nil {
		return 0, err
	}
	if err := i.configureSubids(); err != nil {
		return 0, err
	}
	if err := i.delegateCgroups(ctx, info.UID); err != nil {
		return 0, err
	}
	if err := i.ensureNFTables(ctx); err != nil {
		return 0, err
	}
	if err := i.startRootless(ctx, info); err != nil {
		return 0, err
	}
	if err := i.proveRootless(ctx, info.UID); err != nil {
		return 0, err
	}
	return info.UID, nil
}

// refuseRootfulUsage refuses a host that already runs a rootful daemon: the
// tool never interrupts existing workloads implicitly.
func (i *Installer) refuseRootfulUsage(ctx context.Context) error {
	for _, u := range rootfulUnits {
		active, err := i.Systemd.IsActive(ctx, u)
		if err != nil {
			return err
		}
		if active {
			return fmt.Errorf("rootful %s is active; stop or migrate it explicitly before continuing", u)
		}
	}
	return i.requireNoRootfulProcess(ctx)
}

func (i *Installer) requireNoRootfulProcess(ctx context.Context) error {
	out, err := exec.Output(ctx, i.Runner, "/usr/bin/ps", "-eo", "uid=,comm=")
	if err != nil {
		return err
	}
	if RootfulDaemonRunning(out) {
		return errors.New("a rootful dockerd or containerd runs as uid 0")
	}
	if fsx.Exists(rootfulSock) {
		return errors.New(rootfulSock + " exists: a rootful Docker socket is present")
	}
	return nil
}

// RootfulDaemonRunning parses `ps -eo uid=,comm=` for a uid-0 dockerd/containerd.
func RootfulDaemonRunning(ps string) bool {
	for _, line := range strings.Split(ps, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == "0" && (f[1] == "dockerd" || f[1] == "containerd") {
			return true
		}
	}
	return false
}

func (i *Installer) installRepository(ctx context.Context) error {
	if err := fsx.EnsureDir("/etc/apt/keyrings", 0o755, fsx.Root); err != nil {
		return err
	}
	if err := i.Download.Fetch(ctx, "https://download.docker.com/linux/debian/gpg", keyringPath, download.SHA256, pins.DockerAPTKeySHA256, 0o644, fsx.Root); err != nil {
		return err
	}
	fps, err := i.Apt.KeyFingerprints(ctx, keyringPath)
	if err != nil {
		return err
	}
	found := false
	for _, f := range fps {
		if f == pins.DockerAPTKeyFingerprint {
			found = true
		}
	}
	if !found {
		return errors.New("the Docker repository key does not carry the pinned fingerprint")
	}
	content, err := render.DockerSources(i.Codename, i.Arch.DebArch)
	if err != nil {
		return err
	}
	changed := true
	if cur, err := os.ReadFile(sourcesPath); err == nil && string(cur) == content {
		changed = false
	}
	if changed {
		if err := fsx.WriteAtomic(sourcesPath, []byte(content), 0o644, fsx.Root); err != nil {
			return err
		}
	}
	return i.Apt.Update(ctx)
}

func (i *Installer) maskRootful(ctx context.Context) error {
	for _, u := range rootfulUnits {
		_ = i.Systemd.Stop(ctx, u)
		_ = i.Systemd.Disable(ctx, u)
		if err := i.Systemd.Mask(ctx, u); err != nil {
			return err
		}
	}
	// The package's first start leaves the socket behind once the unit is
	// stopped; a stale socket is a false "rootful Docker here" signal.
	if err := fsx.Remove(rootfulSock); err != nil {
		return err
	}
	for _, u := range rootfulUnits {
		res, err := i.Systemd.Query(ctx, "is-enabled", u, 0)
		if err != nil {
			return err
		}
		if strings.TrimSpace(res.Stdout) != "masked" {
			return fmt.Errorf("rootful %s is not masked", u)
		}
		active, err := i.Systemd.IsActive(ctx, u)
		if err != nil {
			return err
		}
		if active {
			return fmt.Errorf("rootful %s is still active", u)
		}
	}
	if fsx.Exists(rootfulSock) {
		return errors.New(rootfulSock + " still exists after masking")
	}
	return nil
}

// SubidLine renders the /etc/subuid line for the service user.
func SubidLine(start, count int) string {
	return fmt.Sprintf("%s:%d:%d", layout.ServiceUser, start, count)
}

// UpsertSubid replaces or appends the service user's line in a subid file.
func UpsertSubid(content string, start, count int) string {
	line := SubidLine(start, count)
	var out []string
	replaced := false
	for _, l := range strings.Split(strings.TrimRight(content, "\n"), "\n") {
		if l == "" {
			continue
		}
		if strings.HasPrefix(l, layout.ServiceUser+":") {
			if !replaced {
				out = append(out, line)
				replaced = true
			}
			continue
		}
		out = append(out, l)
	}
	if !replaced {
		out = append(out, line)
	}
	return strings.Join(out, "\n") + "\n"
}

func (i *Installer) configureSubids() error {
	start, count := i.Subid()
	if i.LXC && start+count > 65536 {
		return fmt.Errorf("subid range %d:%d exceeds the container uid space", start, count)
	}
	for _, p := range []string{"/etc/subuid", "/etc/subgid"} {
		cur, err := os.ReadFile(p)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		next := UpsertSubid(string(cur), start, count)
		if next == string(cur) {
			continue
		}
		if err := fsx.WriteAtomic(p, []byte(next), 0o644, fsx.Root); err != nil {
			return err
		}
	}
	return nil
}

// delegateCgroups delegates cpu/cpuset/io/memory/pids to user managers:
// memory and pids are delegated by default, cpu/cpuset/io are not, and
// without them `docker run --cpus` fails in rootless mode, which Hermes
// would silently turn into "no limits at all".
func (i *Installer) delegateCgroups(ctx context.Context, uid int) error {
	content, err := render.DockerDelegateConf()
	if err != nil {
		return err
	}
	if err := fsx.EnsureDir(delegateDir, 0o755, fsx.Root); err != nil {
		return err
	}
	changed := true
	if cur, err := os.ReadFile(delegatePth); err == nil && string(cur) == content {
		changed = false
	}
	if changed {
		if err := fsx.WriteAtomic(delegatePth, []byte(content), 0o644, fsx.Root); err != nil {
			return err
		}
		if err := i.Systemd.DaemonReload(ctx); err != nil {
			return err
		}
	}
	if !fsx.Exists("/var/lib/systemd/linger/" + layout.ServiceUser) {
		if _, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: "/usr/bin/loginctl", Args: []string{"enable-linger", layout.ServiceUser}}); err != nil {
			return err
		}
	}
	unit := fmt.Sprintf("user@%d.service", uid)
	if changed {
		if err := i.Systemd.Restart(ctx, unit); err != nil {
			return err
		}
	} else if err := i.Systemd.Start(ctx, unit); err != nil {
		return err
	}
	return waitPath(ctx, fmt.Sprintf("/run/user/%d/bus", uid), 60*time.Second)
}

// ensureNFTables loads nf_tables before dockerd-rootless-setuptool.sh runs:
// the tool refuses to proceed without it, and Debian's cloud kernel does not
// load it on demand. The modules-load.d entry keeps it loaded after a reboot.
// An unprivileged container shares the host kernel and cannot load modules:
// there the module must already be loaded by the host.
func (i *Installer) ensureNFTables(ctx context.Context) error {
	if !i.LXC {
		content, err := render.DockerModulesLoad()
		if err != nil {
			return err
		}
		if cur, err := os.ReadFile(i.ModulesLoad); err != nil || string(cur) != content {
			if err := fsx.WriteAtomic(i.ModulesLoad, []byte(content), 0o644, fsx.Current()); err != nil {
				return err
			}
		}
	}
	if ModuleLoaded(i.ProcModules, "nf_tables") {
		return nil
	}
	if _, err := exec.Must(ctx, i.Runner, exec.Cmd{Path: "/usr/sbin/modprobe", Args: []string{"nf_tables"}}); err != nil {
		if i.LXC {
			return fmt.Errorf("nf_tables is not loaded and this container cannot load it; run `modprobe nf_tables` on the Proxmox host (persist it in /etc/modules-load.d/): %w", err)
		}
		return fmt.Errorf("load the nf_tables kernel module required by rootless Docker: %w", err)
	}
	return nil
}

// ModuleLoaded reports whether /proc/modules (at path) lists the module. An
// unreadable file reports false: modprobe is then the proof.
func ModuleLoaded(path, module string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if name, _, _ := strings.Cut(line, " "); name == module {
			return true
		}
	}
	return false
}

func waitPath(ctx context.Context, path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fsx.Exists(path) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("%s did not appear within %s", path, timeout)
}

func (i *Installer) startRootless(ctx context.Context, info *account.Info) error {
	owner := fsx.Owner{UID: info.UID, GID: info.GID}
	home := "/home/" + layout.ServiceUser
	cfgDir := home + "/.config/docker"
	if err := fsx.EnsureDirUnder(home, cfgDir, 0o755, owner); err != nil {
		return err
	}
	daemon, err := render.DockerDaemonJSON()
	if err != nil {
		return err
	}
	daemonChanged := true
	if cur, err := os.ReadFile(cfgDir + "/daemon.json"); err == nil && string(cur) == daemon {
		daemonChanged = false
	}
	if daemonChanged {
		if err := fsx.WriteAtomic(cfgDir+"/daemon.json", []byte(daemon), 0o644, owner); err != nil {
			return err
		}
	}
	installed := fsx.Exists("/home/" + layout.ServiceUser + "/.config/systemd/user/docker.service")
	if !installed {
		cmd := AsRootless(info.UID, "dockerd-rootless-setuptool.sh", "install")
		cmd.Timeout = 10 * time.Minute
		if _, err := exec.Must(ctx, i.Runner, cmd); err != nil {
			return err
		}
	}
	if _, err := exec.Must(ctx, i.Runner, AsRootless(info.UID, "systemctl", "--user", "enable", "--now", "docker.service")); err != nil {
		return err
	}
	if daemonChanged && installed {
		if _, err := exec.Must(ctx, i.Runner, AsRootless(info.UID, "systemctl", "--user", "restart", "docker.service")); err != nil {
			return err
		}
	}
	return waitPath(ctx, fmt.Sprintf("/run/user/%d/docker.sock", info.UID), 60*time.Second)
}

// Info is the subset of `docker info --format json` the proof reads.
type Info struct {
	CgroupVersion   string   `json:"CgroupVersion"`
	SecurityOptions []string `json:"SecurityOptions"`
}

// RequireRootlessCgroupV2 checks the daemon description.
func RequireRootlessCgroupV2(infoJSON string) error {
	var info Info
	if err := json.Unmarshal([]byte(infoJSON), &info); err != nil {
		return fmt.Errorf("docker info: %w", err)
	}
	if info.CgroupVersion != "2" || !strings.Contains(strings.Join(info.SecurityOptions, " "), "rootless") {
		return fmt.Errorf("dockerd is not rootless + cgroup v2: %v", info.SecurityOptions)
	}
	return nil
}

// CgroupProbeExpected is what a container started with --cpus 0.5 --memory
// 64m --pids-limit 32 must read from its own cgroup.
var CgroupProbeExpected = []string{"67108864", "50000 100000", "32"}

// RequireCgroupLimits checks the probe output line by line.
func RequireCgroupLimits(out string) error {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 {
		return fmt.Errorf("cgroup probe printed %d lines, want 3: %q", len(lines), out)
	}
	for k, want := range CgroupProbeExpected {
		if strings.TrimSpace(lines[k]) != want {
			return fmt.Errorf("cgroup limits seen from the container: %v (want %v): incomplete delegation", lines, CgroupProbeExpected)
		}
	}
	return nil
}

func (i *Installer) proveRootless(ctx context.Context, uid int) error {
	var infoOut string
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		res, e := i.Runner.Run(ctx, AsRootless(uid, "docker", "info", "--format", "json"))
		if e == nil && res.ExitCode == 0 {
			infoOut, err = res.Stdout, nil
			break
		}
		err = fmt.Errorf("docker info failed: %s", strings.TrimSpace(res.Stderr))
		time.Sleep(3 * time.Second)
	}
	if err != nil {
		return err
	}
	if err := RequireRootlessCgroupV2(infoOut); err != nil {
		return err
	}
	// The proof, not the presumption: a container started WITH limits,
	// reading its own cgroup. Hermes' own probe keeps going without limits on
	// failure: here it fails the deploy.
	probe := AsRootless(uid, "docker", "run", "--rm", "--cpus", "0.5", "--memory", "64m", "--pids-limit", "32", pins.DockerProbeImage,
		"cat", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/pids.max")
	probe.Timeout = 10 * time.Minute
	res, err := exec.Must(ctx, i.Runner, probe)
	if err != nil {
		return err
	}
	if err := RequireCgroupLimits(res.Stdout); err != nil {
		return err
	}
	return i.requireNoRootfulProcess(ctx)
}
