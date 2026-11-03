// Package sandbox turns the runtime's terminal backend into isolated,
// ephemeral Docker containers, sizes the gateway's run concurrency to the
// machine, and bounds the api_server toolset catalogue. Everything here is
// a `terminal.*` / `gateway.api_server.*` key of the upstream config.yaml,
// Hermes' own DockerEnvironment runs the sandboxes.
package sandbox

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/docker"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Standard resource class: cpu = docker --cpus, memory in MB. Calibrated for
// a 2 vCPU / 8 GB reference machine.
const (
	ClassCPU        = 0.5
	ClassMemoryMB   = 512
	LifetimeSeconds = 300
	TimeoutSeconds  = 180
	// ReservedMemoryMB is kept out of the sandbox budget: OS, gateway,
	// rootless dockerd and page cache.
	ReservedMemoryMB = 2560
)

// Machine sizes the concurrency cap.
type Machine struct {
	VCPUs      int
	MemTotalMB int
}

// MaxConcurrentRuns derives the gateway cap: min(cpu-bound, ram-bound), at
// least 1.
func MaxConcurrentRuns(m Machine) int {
	cpu := int(float64(m.VCPUs) / ClassCPU)
	ram := (m.MemTotalMB - ReservedMemoryMB) / ClassMemoryMB
	n := cpu
	if ram < n {
		n = ram
	}
	if n < 1 {
		n = 1
	}
	return n
}

// Settings are the exact keys written to config.yaml (upstream
// TERMINAL_CONFIG_ENV_MAP). Values are strings on purpose: `hermes config
// set` coerces them and we compare against what `config get` prints back.
func Settings(m Machine) []struct{ Key, Value string } {
	return []struct{ Key, Value string }{
		{"terminal.backend", "docker"},
		{"terminal.docker_image", pins.SandboxImage},
		{"terminal.container_cpu", "0.5"},
		{"terminal.container_memory", "512"},
		{"terminal.container_persistent", "false"},
		{"terminal.docker_network", "true"},
		{"terminal.lifetime_seconds", "300"},
		{"terminal.timeout", "180"},
		{"terminal.sandbox_dir", layout.SandboxDir},
		// A host bind for /workspace: upstream skips its dangerous-command
		// approvals for a sandbox that exposes no host path, and a tmpfs
		// workspace is charged to --memory.
		{"terminal.docker_volumes", `["` + layout.WorkspaceRoot + `:/workspace"]`},
		{"gateway.api_server.max_concurrent_runs", fmt.Sprint(MaxConcurrentRuns(m))},
	}
}

// Installer carries the dependencies of the sandbox phase.
type Installer struct {
	Runner  exec.Runner
	Systemd systemd.Client
	UID     int
	GID     int
	Machine Machine
}

// New wires an installer for the service uid/gid.
func New(r exec.Runner, uid, gid int, m Machine) *Installer {
	return &Installer{Runner: r, Systemd: systemd.Client{Runner: r}, UID: uid, GID: gid, Machine: m}
}

// presentKeys lists which dotted keys exist in the raw config.yaml, without
// upstream defaults: `config get` renders the merged default when a key is
// absent, and an equal-to-default key would never be pinned.
//
//go:embed present_keys.py
var presentKeys string

// contractEdit updates the structured gateway allow-list directly, keeping
// every unrelated key and replacing the file atomically. `config set` is
// reliable for scalars but its list coercion is version-dependent.
//
//go:embed contract_edit.py
var contractEdit string

//go:embed contract_probe.py
var contractProbe string

func (i *Installer) venvPython(script string, args ...string) exec.Cmd {
	return hermes.CLIWith(layout.VenvBin+"/python", append([]string{"-c", script}, args...)...)
}

// Run applies the sandbox configuration and proves the isolation.
func (i *Installer) Run(ctx context.Context) (bool, error) {
	owner := fsx.Owner{UID: i.UID, GID: i.GID}
	for _, d := range []string{layout.SandboxDir, layout.WorkspaceRoot} {
		if err := fsx.EnsureDir(d, 0o700, owner); err != nil {
			return false, err
		}
	}
	if err := ensureImage(ctx, i.Runner, i.UID); err != nil {
		return false, err
	}
	settings := Settings(i.Machine)
	keys := make([]string, 0, len(settings))
	for _, s := range settings {
		keys = append(keys, s.Key)
	}
	keysJSON, _ := json.Marshal(keys)
	res, err := exec.Must(ctx, i.Runner, i.venvPython(presentKeys, layout.RuntimeConfig, string(keysJSON)))
	if err != nil {
		return false, err
	}
	var present []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &present); err != nil {
		return false, fmt.Errorf("present keys: %w", err)
	}
	isPresent := map[string]bool{}
	for _, k := range present {
		isPresent[k] = true
	}
	terminalChanged := false
	for _, s := range settings {
		cur, _ := i.Runner.Run(ctx, hermes.CLI("config", "get", s.Key))
		if isPresent[s.Key] && SameValue(s.Key, strings.TrimSpace(cur.Stdout), s.Value) {
			continue
		}
		if _, err := exec.Must(ctx, i.Runner, hermes.CLI("config", "set", "--force", s.Key, s.Value)); err != nil {
			return false, err
		}
		terminalChanged = true
	}
	toolsets, _ := json.Marshal(pins.APIToolsets)
	if _, err := exec.Must(ctx, i.Runner, i.venvPython(contractEdit, layout.RuntimeConfig, string(toolsets))); err != nil {
		return false, err
	}
	probe, err := exec.Must(ctx, i.Runner, i.venvPython(contractProbe, layout.RuntimeConfig, string(toolsets)))
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(probe.Stdout) != "ok" {
		return false, errors.New("config.yaml does not carry the api_server toolset contract")
	}
	// Terminal settings go through the config→env bridge loaded at start:
	// only they justify a restart. The API/memory contract is re-read per
	// request and must not cut running sessions.
	if terminalChanged {
		if err := i.Systemd.Restart(ctx, layout.GatewayUnit); err != nil {
			return false, err
		}
	}
	if err := gateway.Loopback("").WaitHealthy(ctx, 60*time.Second); err != nil {
		return false, err
	}
	backend, err := exec.Must(ctx, i.Runner, hermes.CLI("config", "get", "terminal.backend"))
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(backend.Stdout) != "docker" {
		return false, fmt.Errorf("terminal.backend = %q, want docker", strings.TrimSpace(backend.Stdout))
	}
	return terminalChanged, i.proveLoopbackIsolation(ctx)
}

// ApplyContractOnly writes the api_server toolset contract and disables
// native memory without touching the terminal backend (hosts without --sandbox).
func ApplyContractOnly(ctx context.Context, r exec.Runner, uid, gid int) error {
	i := &Installer{Runner: r, Systemd: systemd.Client{Runner: r}, UID: uid, GID: gid}
	toolsets, _ := json.Marshal(pins.APIToolsets)
	if _, err := exec.Must(ctx, r, i.venvPython(contractEdit, layout.RuntimeConfig, string(toolsets))); err != nil {
		return err
	}
	probe, err := exec.Must(ctx, r, i.venvPython(contractProbe, layout.RuntimeConfig, string(toolsets)))
	if err != nil {
		return err
	}
	if strings.TrimSpace(probe.Stdout) != "ok" {
		return errors.New("config.yaml does not carry the api_server toolset contract")
	}
	return nil
}

// SameValue compares a `config get` rendering with the desired value.
func SameValue(key, got, want string) bool {
	if key == "terminal.docker_volumes" {
		var a, b []string
		if json.Unmarshal([]byte(got), &a) != nil || json.Unmarshal([]byte(want), &b) != nil {
			return strings.EqualFold(got, want)
		}
		return strings.Join(a, "\x00") == strings.Join(b, "\x00")
	}
	return strings.EqualFold(got, want)
}

// proveLoopbackIsolation proves that sandboxes cannot reach the gateway
// through RootlessKit's host loopback address (--disable-host-loopback is the
// upstream default; we measure it).
//
// The driver assertion reads the RootlessKit command line of the service
// user: since Docker 25 dockerd-rootless.sh runs with --detach-netns, so a
// `--network host` container shares the daemon's namespace and sees the real
// host routes, not slirp4netns' 10.0.2.2. Only bridge containers go through
// slirp4netns, and that is where the probe below measures the isolation.
func (i *Installer) proveLoopbackIsolation(ctx context.Context) error {
	cmdline, err := rootlessKitCmdline(ctx, i.Runner, i.UID)
	if err != nil {
		return err
	}
	if err := checkRootlessKitNetwork(cmdline); err != nil {
		return err
	}
	for _, port := range []int{layout.GatewayPort} {
		probe := docker.AsRootless(i.UID, "docker", "run", "--rm", pins.DockerProbeImage, "sh", "-c", fmt.Sprintf("wget -T 3 -q -O- http://10.0.2.2:%d/ ; echo RC=$?", port))
		probe.Timeout = 5 * time.Minute
		res, err := i.Runner.Run(ctx, probe)
		if err != nil {
			return err
		}
		if strings.Contains(res.Stdout, "RC=0") {
			return fmt.Errorf("a sandbox reached 10.0.2.2:%d: disable-host-loopback is not active", port)
		}
	}
	return nil
}

// rootlessKitCmdline returns the argv of the RootlessKit parent process of
// uid, NUL bytes replaced by spaces. Exactly one such process is expected:
// the one spawned by the user docker.service.
func rootlessKitCmdline(ctx context.Context, r exec.Runner, uid int) (string, error) {
	res, err := exec.Must(ctx, r, exec.Cmd{Path: "/bin/sh", Args: []string{"-c", fmt.Sprintf("for p in $(pgrep -u %d -x rootlesskit); do tr '\\0' ' ' < /proc/$p/cmdline; echo; done", uid)}})
	if err != nil {
		return "", fmt.Errorf("rootlesskit of uid %d: %w", uid, err)
	}
	lines := strings.Split(strings.TrimSpace(res.Stdout), "\n")
	if len(lines) != 1 || strings.TrimSpace(lines[0]) == "" {
		return "", fmt.Errorf("expected exactly one rootlesskit process for uid %d, found %d", uid, len(strings.Fields(strings.TrimSpace(res.Stdout))))
	}
	return lines[0], nil
}

// checkRootlessKitNetwork asserts the network driver the loopback probe
// relies on: slirp4netns (10.0.2.2 is the host) with host loopback disabled.
// pasta or vpnkit expose the host under other addresses and would make the
// probe vacuous, so they are refused here rather than silently passing.
func checkRootlessKitNetwork(cmdline string) error {
	fields := strings.Fields(cmdline)
	var net string
	hostLoopbackDisabled := false
	for idx, f := range fields {
		switch {
		case strings.HasPrefix(f, "--net="):
			net = strings.TrimPrefix(f, "--net=")
		case f == "--net" && idx+1 < len(fields):
			net = fields[idx+1]
		case f == "--disable-host-loopback":
			hostLoopbackDisabled = true
		}
	}
	if net != "slirp4netns" {
		return fmt.Errorf("RootlessKit runs --net=%q instead of slirp4netns: the network driver changed, revalidate loopback isolation", net)
	}
	if !hostLoopbackDisabled {
		return errors.New("RootlessKit runs without --disable-host-loopback: sandboxes could reach the host loopback")
	}
	return nil
}

// ensureImage makes the pinned sandbox image available. It is pinned by
// digest: when that exact digest is already in the rootless store, pulling
// again proves nothing and only exposes up to the registry's anonymous rate
// limit (Docker Hub answers 429).
func ensureImage(ctx context.Context, r exec.Runner, uid int) error {
	inspect := docker.AsRootless(uid, "docker", "image", "inspect", "--format", "{{.Id}}", pins.SandboxImage)
	if res, err := r.Run(ctx, inspect); err == nil && res.ExitCode == 0 {
		return nil
	}
	pull := docker.AsRootless(uid, "docker", "pull", "--quiet", pins.SandboxImage)
	pull.Timeout = 15 * time.Minute
	_, err := exec.Must(ctx, r, pull)
	return err
}
