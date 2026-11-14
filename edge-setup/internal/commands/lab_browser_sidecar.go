package commands

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/docker"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type labBrowserSidecarSpec struct {
	Nonce       string               `json:"nonce"`
	UID         int                  `json:"uid"`
	Asset       hermes.ChromiumAsset `json:"asset"`
	ShortTmpDir bool                 `json:"shortTmpDir,omitempty"`
	LogToStderr bool                 `json:"logToStderr,omitempty"`
}
type labBrowserSidecarState struct {
	Unit              string `json:"unit"`
	ExecFingerprint   string `json:"execFingerprint"`
	InvocationID      string `json:"invocationId"`
	StartTicks        string `json:"startTicks"`
	ControlGroup      string `json:"controlGroup"`
	MainPID           int    `json:"mainPid"`
	Running           bool   `json:"running"`
	Stopped           bool   `json:"stopped"`
	ResourcesVerified bool   `json:"resourcesVerified"`
}

var sidecarNonce = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var sidecarInvocation = regexp.MustCompile(`^[0-9a-f]{32}$`)
var sidecarTicks = regexp.MustCompile(`^[1-9][0-9]*$`)
var sidecarProperties = []string{"Id", "LoadState", "ActiveState", "SubState", "Transient", "Description", "ExecStart", "InvocationID", "MainPID", "ControlPID", "ControlGroup", "MemoryMax", "CPUQuotaPerSecUSec", "TasksMax", "RuntimeMaxUSec", "TimeoutStopUSec", "Restart", "KillMode", "NoNewPrivileges", "RemainAfterExit", "ExecCondition", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost", "DropInPaths", "WorkingDirectory", "Type", "SendSIGKILL"}
var sidecarLimits = []string{"Type=exec", "MemoryMax=1G", "CPUQuota=100%", "TasksMax=256", "RuntimeMaxSec=600", "Restart=no", "KillMode=control-group", "TimeoutStopSec=5", "NoNewPrivileges=true", "RemainAfterExit=yes", "SendSIGKILL=true"}

func labBrowserSidecarHome(spec labBrowserSidecarSpec) string {
	return "/srv/hermes/data/lab-browser-fixtures/" + spec.Nonce + "/home"
}
func sidecarBrowserArgs(spec labBrowserSidecarSpec) []string {
	args := []string{spec.Asset.Executable, "--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--no-pings", "--user-data-dir=" + labBrowserSidecarHome(spec) + "/userdata", "about:blank"}
	if spec.LogToStderr {
		args = append([]string{args[0], "--enable-logging=stderr"}, args[1:]...)
	}
	return args
}

// Chromium appends a unique scope and SingletonSocket beneath TMPDIR.
// Keep new fixtures below sockaddr_un's 108-byte limit without changing the
// argv/fingerprint of any already-owned legacy service.
func labBrowserSidecarTmp(spec labBrowserSidecarSpec) string {
	if !spec.ShortTmpDir {
		return labBrowserSidecarHome(spec) + "/tmp"
	}
	return fmt.Sprintf("/run/user/%d/ob-%s", spec.UID, strings.ReplaceAll(spec.Nonce, "-", ""))
}
func sidecarExec(spec labBrowserSidecarSpec) []string {
	home := labBrowserSidecarHome(spec)
	return append([]string{"/usr/bin/env", "-i", "HOME=" + home, "XDG_CONFIG_HOME=" + home + "/config", "XDG_CACHE_HOME=" + home + "/cache", "TMPDIR=" + labBrowserSidecarTmp(spec), "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "USER=hermes", "LOGNAME=hermes"}, sidecarBrowserArgs(spec)...)
}
func labBrowserSidecarIntent(spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
	var state labBrowserSidecarState
	if !sidecarNonce.MatchString(spec.Nonce) || spec.UID <= 0 {
		return state, errors.New("invalid browser sidecar nonce or service UID")
	}
	if spec.ShortTmpDir && (uint64(spec.UID) > 4294967295 || len(labBrowserSidecarTmp(spec)+"/.org.chromium.Chromium.XXXXXX/SingletonSocket") > 107) {
		return state, errors.New("browser sidecar temporary socket path exceeds its safe bound")
	}
	arch := ""
	switch spec.Asset.Target {
	case "linux-x64":
		arch = "amd64"
	case "linux-arm64":
		arch = "arm64"
	default:
		return state, errors.New("unsupported browser sidecar asset")
	}
	pin, err := pins.ChromiumFor("linux", arch)
	if err != nil {
		return state, err
	}
	base := "/usr/local/lib/hermes-chromium/" + pin.Target + "-" + pin.SHA256 + "/"
	path := spec.Asset.Executable
	if spec.Asset.Version != pins.ChromiumVersion || spec.Asset.ArchiveSHA256 != pin.SHA256 || !strings.HasPrefix(path, base) || filepath.Clean(path) != path || strings.ContainsAny(path, " \t\r\n;\\\"'\x00") || (filepath.Base(path) != "chrome" && filepath.Base(path) != "chromium") {
		return state, errors.New("browser sidecar requires the immutable pinned Chromium asset")
	}
	command := append([]string{spec.Nonce, strconv.Itoa(spec.UID)}, sidecarLimits...)
	command = append(command, sidecarExec(spec)...)
	digest := sha256.Sum256([]byte(strings.Join(command, "\x00")))
	return labBrowserSidecarState{Unit: "e2e-hermes-browser-" + strings.ReplaceAll(spec.Nonce, "-", "") + ".service", ExecFingerprint: hex.EncodeToString(digest[:])}, nil
}
func sidecarDescription(state labBrowserSidecarState) string {
	return "openedbot-lab-browser-" + state.ExecFingerprint
}
func sidecarUserCommand(spec labBrowserSidecarSpec, path string, args ...string) exec.Cmd {
	env := []string{"HOME=" + labBrowserSidecarHome(spec), "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C"}
	for _, entry := range docker.RootlessEnv(spec.UID) {
		if strings.HasPrefix(entry, "XDG_RUNTIME_DIR=") || strings.HasPrefix(entry, "DBUS_SESSION_BUS_ADDRESS=") {
			env = append(env, entry)
		}
	}
	wrapped := []string{"-u", layout.ServiceUser, "--", "/usr/bin/env", "-i"}
	wrapped = append(wrapped, env...)
	wrapped = append(wrapped, path)
	wrapped = append(wrapped, args...)
	return exec.Cmd{Path: "/usr/sbin/runuser", Args: wrapped, Env: []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C"}, Timeout: 15 * time.Second}
}

type labBrowserSidecarController struct {
	runner   exec.Runner
	read     func(string) ([]byte, error)
	readlink func(string) (string, error)
	sleep    func(context.Context) error
}

func sidecarController(runner exec.Runner) labBrowserSidecarController {
	return labBrowserSidecarController{runner: runner, read: func(path string) ([]byte, error) {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, 16385))
		if len(data) > 16384 {
			return nil, errors.New("sidecar process proof exceeds bound")
		}
		return data, err
	}, readlink: os.Readlink, sleep: func(ctx context.Context) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
			return nil
		}
	}}
}
func startLabBrowserSidecar(ctx context.Context, runner exec.Runner, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
	return sidecarController(runner).start(ctx, spec)
}
func inspectLabBrowserSidecar(ctx context.Context, runner exec.Runner, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
	return sidecarController(runner).inspect(ctx, spec)
}
func stopLabBrowserSidecar(ctx context.Context, runner exec.Runner, spec labBrowserSidecarSpec, expected labBrowserSidecarState) (labBrowserSidecarState, error) {
	return sidecarController(runner).stop(ctx, spec, expected)
}

func (c labBrowserSidecarController) inspect(ctx context.Context, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
	intent, err := labBrowserSidecarIntent(spec)
	if err != nil {
		return intent, err
	}
	result, err := c.runner.Run(ctx, sidecarUserCommand(spec, "/usr/bin/systemctl", "--user", "show", "--all", "--no-pager", "--property="+strings.Join(sidecarProperties, ","), "--", intent.Unit))
	if err != nil {
		return intent, errors.New("browser sidecar user-unit inventory unavailable")
	}
	if len(result.Stdout) > 16384 {
		return intent, errors.New("browser sidecar inventory exceeded bound")
	}
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(result.Stdout), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			return intent, errors.New("invalid browser sidecar unit inventory")
		}
		if _, duplicate := values[key]; duplicate {
			return intent, errors.New("duplicate browser sidecar unit property")
		}
		values[key] = value
	}
	// A real not-found observation is required, never an arbitrary command error.
	if values["LoadState"] == "not-found" && (result.ExitCode == 0 || result.ExitCode == 4) && values["MainPID"] == "0" && values["ActiveState"] == "inactive" {
		intent.Stopped = true
		return intent, nil
	}
	// systemd v257 prints Exec* command arrays once per element, so an
	// empty array has no output line even with --all. Only these five known
	// hook arrays may be absent; nonempty arrays remain explicitly forbidden.
	// https://github.com/systemd/systemd/blob/v257/src/systemctl/systemctl-show.c#L1285
	for _, hook := range []string{"ExecCondition", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"} {
		if _, present := values[hook]; !present {
			values[hook] = ""
		}
	}
	for _, property := range sidecarProperties {
		if _, present := values[property]; !present {
			return intent, errors.New("incomplete browser sidecar unit inventory")
		}
	}
	if result.ExitCode != 0 || len(values) != len(sidecarProperties) {
		return intent, errors.New("incomplete browser sidecar unit inventory")
	}
	expected := map[string]string{"Id": intent.Unit, "LoadState": "loaded", "Transient": "yes", "Description": sidecarDescription(intent), "MemoryMax": "1073741824", "CPUQuotaPerSecUSec": "1s", "TasksMax": "256", "RuntimeMaxUSec": "10min", "TimeoutStopUSec": "5s", "Restart": "no", "KillMode": "control-group", "NoNewPrivileges": "yes", "RemainAfterExit": "yes", "ExecCondition": "", "ExecStartPre": "", "ExecStartPost": "", "ExecStop": "", "ExecStopPost": "", "DropInPaths": "", "WorkingDirectory": labBrowserSidecarHome(spec), "Type": "exec", "SendSIGKILL": "yes"}
	for key, value := range expected {
		if values[key] != value {
			return intent, fmt.Errorf("browser sidecar unit ownership or resource binding differs: %s", key)
		}
	}
	prefix := "{ path=/usr/bin/env ; argv[]=" + strings.Join(sidecarExec(spec), " ") + " ; ignore_errors=no ;"
	if !strings.HasPrefix(values["ExecStart"], prefix) {
		return intent, errors.New("browser sidecar ExecStart differs from durable intent")
	}
	invocation := values["InvocationID"]
	if (values["ActiveState"] == "active" || (invocation != "" && strings.Trim(invocation, "0") != "")) && (!sidecarInvocation.MatchString(invocation) || strings.Trim(invocation, "0") == "") {
		return intent, errors.New("browser sidecar InvocationID invalid")
	}
	state := intent
	if strings.Trim(invocation, "0") != "" {
		state.InvocationID = invocation
	}
	state.ControlGroup = values["ControlGroup"]
	state.ResourcesVerified = true
	prefixGroup := fmt.Sprintf("/user.slice/user-%d.slice/user@%d.service/", spec.UID, spec.UID)
	if (values["ActiveState"] == "active" || state.ControlGroup != "") && (!strings.HasPrefix(state.ControlGroup, prefixGroup) || !strings.HasSuffix(state.ControlGroup, "/"+intent.Unit) || filepath.Clean(state.ControlGroup) != state.ControlGroup) {
		return intent, errors.New("browser sidecar is outside its nonce-bound user cgroup")
	}
	pid, err := strconv.Atoi(values["MainPID"])
	if err != nil || pid < 0 || strconv.Itoa(pid) != values["MainPID"] || values["ControlPID"] != "0" {
		return intent, errors.New("browser sidecar PID inventory invalid")
	}
	switch values["ActiveState"] {
	case "active":
		if pid == 0 || values["SubState"] != "running" {
			return state, errors.New("browser sidecar has no live main process")
		}
		ticks, err := c.process(spec, pid, state.ControlGroup)
		if err != nil {
			return state, err
		}
		state.MainPID = pid
		state.StartTicks = ticks
		state.Running = true
	case "inactive", "failed":
		if pid != 0 {
			return state, errors.New("inactive browser sidecar retains a main PID")
		}
		state.Stopped = true
	default:
		return state, errors.New("browser sidecar is in an unconfirmed transitional state")
	}
	return state, nil
}
func (c labBrowserSidecarController) process(spec labBrowserSidecarSpec, pid int, cgroup string) (string, error) {
	base := "/proc/" + strconv.Itoa(pid) + "/"
	before, err := c.read(base + "stat")
	if err != nil {
		return "", errors.New("browser sidecar PID disappeared or is unreadable")
	}
	ticks, err := sidecarProcessTicks(before)
	if err != nil {
		return "", err
	}
	status, err := c.read(base + "status")
	if err != nil {
		return "", err
	}
	uidFound := false
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "Uid:") {
			fields := strings.Fields(line)
			if len(fields) != 5 {
				return "", errors.New("browser sidecar UID invalid")
			}
			for _, uid := range fields[1:] {
				if uid != strconv.Itoa(spec.UID) {
					return "", errors.New("browser sidecar process has foreign UID")
				}
			}
			uidFound = true
		}
	}
	if !uidFound {
		return "", errors.New("browser sidecar UID missing")
	}
	executable, err := c.readlink(base + "exe")
	if err != nil || executable != spec.Asset.Executable {
		return "", errors.New("browser sidecar process executable differs")
	}
	command, err := c.read(base + "cmdline")
	if err != nil || string(command) != strings.Join(sidecarBrowserArgs(spec), "\x00")+"\x00" {
		return "", errors.New("browser sidecar process argv differs")
	}
	groups, err := c.read(base + "cgroup")
	if err != nil || strings.TrimSpace(string(groups)) != "0::"+cgroup {
		return "", errors.New("browser sidecar process cgroup differs")
	}
	after, err := c.read(base + "stat")
	if err != nil {
		return "", err
	}
	confirmed, err := sidecarProcessTicks(after)
	if err != nil || confirmed != ticks {
		return "", errors.New("browser sidecar PID was reused during observation")
	}
	return ticks, nil
}
func sidecarProcessTicks(stat []byte) (string, error) {
	index := strings.LastIndex(string(stat), ")")
	if index < 0 {
		return "", errors.New("invalid browser sidecar process stat")
	}
	fields := strings.Fields(string(stat[index+1:]))
	if len(fields) <= 19 || !sidecarTicks.MatchString(fields[19]) {
		return "", errors.New("browser sidecar process start ticks missing")
	}
	return fields[19], nil
}
func (c labBrowserSidecarController) gone(expected labBrowserSidecarState) (bool, error) {
	if expected.MainPID == 0 {
		return expected.StartTicks == "", nil
	}
	if !sidecarTicks.MatchString(expected.StartTicks) {
		return false, errors.New("browser sidecar durable PID identity invalid")
	}
	stat, err := c.read("/proc/" + strconv.Itoa(expected.MainPID) + "/stat")
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	ticks, err := sidecarProcessTicks(stat)
	return err == nil && ticks != expected.StartTicks, err
}
func (c labBrowserSidecarController) start(ctx context.Context, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
	intent, err := labBrowserSidecarIntent(spec)
	if err != nil {
		return intent, err
	}
	before, err := c.inspect(ctx, spec)
	if err != nil {
		return intent, err
	}
	if before.Running {
		return before, nil
	}
	if before.ResourcesVerified {
		return before, errors.New("browser sidecar nonce was already started; it is never restarted")
	}
	args := []string{"--user", "--unit=" + intent.Unit, "--description=" + sidecarDescription(intent), "--quiet"}
	for _, property := range sidecarLimits {
		args = append(args, "--property="+property)
	}
	args = append(args, "--property=WorkingDirectory="+labBrowserSidecarHome(spec), "--")
	args = append(args, sidecarExec(spec)...)
	// An uncertain start is reconciled read-only. It is never blindly retried.
	result, startErr := c.runner.Run(ctx, sidecarUserCommand(spec, "/usr/bin/systemd-run", args...))
	if result.ExitCode != 0 && startErr == nil {
		startErr = errors.New("browser sidecar start command failed")
	}
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		observed, err := c.inspect(wait, spec)
		if err == nil && observed.Running {
			return observed, nil
		}
		if wait.Err() != nil {
			break
		}
		if startErr != nil && err == nil && !observed.ResourcesVerified {
			return intent, errors.New("browser sidecar start outcome unconfirmed; durable intent retained")
		}
		if err := c.sleep(wait); err != nil {
			break
		}
	}
	return intent, errors.New("browser sidecar did not become independently observable; durable intent retained")
}
func (c labBrowserSidecarController) stop(ctx context.Context, spec labBrowserSidecarSpec, expected labBrowserSidecarState) (labBrowserSidecarState, error) {
	intent, err := labBrowserSidecarIntent(spec)
	if err != nil {
		return intent, err
	}
	if expected.Unit != intent.Unit || expected.ExecFingerprint != intent.ExecFingerprint || expected.MainPID < 0 || (expected.InvocationID != "" && !sidecarInvocation.MatchString(expected.InvocationID)) {
		return intent, errors.New("browser sidecar stop receipt does not own this exact intent")
	}
	observed, err := c.inspect(ctx, spec)
	if err != nil {
		return expected, err
	}
	if expected.InvocationID != "" && observed.InvocationID != "" && observed.ResourcesVerified && expected.InvocationID != observed.InvocationID {
		return expected, errors.New("browser sidecar InvocationID was replaced; stop refused")
	}
	if expected.InvocationID == "" && observed.ResourcesVerified {
		expected = observed
	}
	if observed.Running {
		if expected.MainPID > 0 && (observed.MainPID != expected.MainPID || observed.StartTicks != expected.StartTicks) {
			return expected, errors.New("browser sidecar PID identity changed; stop refused")
		}
		expected = observed
		// Re-read the same independently bound process immediately before stop.
		confirmed, err := c.inspect(ctx, spec)
		if err != nil || confirmed.InvocationID != expected.InvocationID || confirmed.MainPID != expected.MainPID || confirmed.StartTicks != expected.StartTicks {
			return expected, errors.New("browser sidecar identity changed before stop")
		}
		result, err := c.runner.Run(ctx, sidecarUserCommand(spec, "/usr/bin/systemctl", "--user", "stop", "--", intent.Unit))
		if err != nil || result.ExitCode != 0 {
			return expected, errors.New("browser sidecar stop outcome unconfirmed; receipt retained")
		}
	}
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		state, err := c.inspect(wait, spec)
		if err != nil {
			return expected, err
		}
		if expected.InvocationID != "" && state.InvocationID != "" && state.ResourcesVerified && state.InvocationID != expected.InvocationID {
			return expected, errors.New("browser sidecar was replaced while stopping")
		}
		gone, err := c.gone(expected)
		if err != nil {
			return expected, err
		}
		if state.Stopped && gone {
			expected.Running = false
			expected.Stopped = true
			return expected, nil
		}
		if wait.Err() != nil {
			break
		}
		if err := c.sleep(wait); err != nil {
			break
		}
	}
	return expected, errors.New("browser sidecar inactivity and original PID disappearance were not proven")
}
