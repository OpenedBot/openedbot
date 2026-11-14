package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

type sidecarFake struct {
	spec                                               labBrowserSidecarSpec
	phase                                              string
	changes                                            map[string]string
	omitted                                            map[string]bool
	calls                                              []exec.Cmd
	starts, stops                                      int
	lostStart, lostStop, retainPID, replacedBeforeStop bool
	gone                                               bool
	statReads                                          int
	procUID, procExe, procArgs, procGroup              string
}

func sidecarFixture(t *testing.T) (labBrowserSidecarController, *sidecarFake) {
	t.Helper()
	pin, err := pins.ChromiumFor("linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	spec := labBrowserSidecarSpec{Nonce: "c7ee6597-a480-44df-a82c-4ad1788dd141", UID: 998, Asset: hermes.ChromiumAsset{Executable: "/usr/local/lib/hermes-chromium/" + pin.Target + "-" + pin.SHA256 + "/chrome-linux64/chrome", Version: pins.ChromiumVersion, ArchiveSHA256: pin.SHA256, Target: pin.Target}}
	fake := &sidecarFake{spec: spec, phase: "missing", changes: map[string]string{}}
	controller := labBrowserSidecarController{runner: fake, read: fake.read, readlink: func(string) (string, error) {
		if fake.procExe != "" {
			return fake.procExe, nil
		}
		return spec.Asset.Executable, nil
	}, sleep: func(context.Context) error { return context.DeadlineExceeded }}
	return controller, fake
}
func (f *sidecarFake) properties() map[string]string {
	intent, _ := labBrowserSidecarIntent(f.spec)
	values := map[string]string{}
	for _, key := range sidecarProperties {
		values[key] = ""
	}
	values["Id"] = intent.Unit
	values["LoadState"] = "not-found"
	values["ActiveState"] = "inactive"
	values["MainPID"] = "0"
	values["ControlPID"] = "0"
	if f.phase != "missing" {
		for key, value := range map[string]string{"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "Transient": "yes", "Description": sidecarDescription(intent), "ExecStart": "{ path=/usr/bin/env ; argv[]=" + strings.Join(sidecarExec(f.spec), " ") + " ; ignore_errors=no ; start_time=[] ; pid=4242 ; code=(null) ; status=0/0 }", "InvocationID": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "MainPID": "4242", "ControlGroup": fmt.Sprintf("/user.slice/user-%d.slice/user@%d.service/app.slice/%s", f.spec.UID, f.spec.UID, intent.Unit), "MemoryMax": "1073741824", "CPUQuotaPerSecUSec": "1s", "TasksMax": "256", "RuntimeMaxUSec": "10min", "TimeoutStopUSec": "5s", "Restart": "no", "KillMode": "control-group", "NoNewPrivileges": "yes", "RemainAfterExit": "yes", "WorkingDirectory": labBrowserSidecarHome(f.spec), "Type": "exec", "SendSIGKILL": "yes"} {
			values[key] = value
		}
		if f.phase == "inactive" || f.phase == "failed" {
			values["ActiveState"] = f.phase
			values["SubState"] = "dead"
			if f.phase == "failed" {
				values["SubState"] = "failed"
			}
			values["MainPID"] = "0"
			values["ControlGroup"] = ""
		}
	}
	for key, value := range f.changes {
		values[key] = value
	}
	return values
}
func (f *sidecarFake) Run(_ context.Context, command exec.Cmd) (exec.Result, error) {
	f.calls = append(f.calls, command)
	if slices.Contains(command.Args, "/usr/bin/systemd-run") {
		f.starts++
		f.phase = "running"
		if f.lostStart {
			return exec.Result{}, errors.New("lost start reply")
		}
		return exec.Result{}, nil
	}
	if slices.Contains(command.Args, "show") {
		if f.replacedBeforeStop && f.starts == 0 && len(f.calls) > 1 {
			f.changes["InvocationID"] = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		}
		values := f.properties()
		var rows []string
		for _, key := range sidecarProperties {
			if !f.omitted[key] {
				rows = append(rows, key+"="+values[key])
			}
		}
		code := 0
		if f.phase == "missing" {
			code = 4
		}
		return exec.Result{Stdout: strings.Join(rows, "\n"), ExitCode: code}, nil
	}
	if slices.Contains(command.Args, "stop") {
		f.stops++
		f.phase = "inactive"
		f.gone = !f.retainPID
		if f.lostStop {
			return exec.Result{}, errors.New("lost stop reply")
		}
		return exec.Result{}, nil
	}
	return exec.Result{}, errors.New("unexpected command")
}
func (f *sidecarFake) read(name string) ([]byte, error) {
	if strings.HasSuffix(name, "/stat") {
		f.statReads++
		if f.gone {
			return nil, os.ErrNotExist
		}
		fields := make([]string, 20)
		for i := range fields {
			fields[i] = "0"
		}
		fields[0] = "S"
		fields[19] = "12345"
		return []byte("4242 (chrome (main)) " + strings.Join(fields, " ")), nil
	}
	if strings.HasSuffix(name, "/status") {
		uid := strconv.Itoa(f.spec.UID)
		if f.procUID != "" {
			uid = f.procUID
		}
		return []byte("Uid:\t" + strings.Join([]string{uid, uid, uid, uid}, "\t") + "\n"), nil
	}
	if strings.HasSuffix(name, "/cmdline") {
		if f.procArgs != "" {
			return []byte(f.procArgs), nil
		}
		return []byte(strings.Join(sidecarBrowserArgs(f.spec), "\x00") + "\x00"), nil
	}
	if strings.HasSuffix(name, "/cgroup") {
		group := f.properties()["ControlGroup"]
		if f.procGroup != "" {
			group = f.procGroup
		}
		return []byte("0::" + group + "\n"), nil
	}
	return nil, os.ErrNotExist
}
func TestLabBrowserSidecarIntentAndBoundedCleanUserStart(t *testing.T) {
	c, f := sidecarFixture(t)
	state, err := c.start(context.Background(), f.spec)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Running || !state.ResourcesVerified || state.MainPID != 4242 || state.StartTicks != "12345" || state.InvocationID == "" || f.starts != 1 {
		t.Fatalf("unproven start: %#v", state)
	}
	for _, command := range f.calls {
		if command.Path != "/usr/sbin/runuser" || strings.Contains(strings.Join(command.Args, " "), "--no-sandbox") || strings.Contains(strings.Join(command.Args, " "), "DOCKER_HOST=") {
			t.Fatal("unsafe service command")
		}
		if !slices.Contains(command.Args, "-i") {
			t.Fatal("environment was inherited")
		}
	}
	var start exec.Cmd
	for _, command := range f.calls {
		if slices.Contains(command.Args, "/usr/bin/systemd-run") {
			start = command
		}
	}
	for _, property := range sidecarLimits {
		if !slices.Contains(start.Args, "--property="+property) {
			t.Fatalf("missing resource %s", property)
		}
	}
	if _, err := c.start(context.Background(), f.spec); err != nil || f.starts != 1 {
		t.Fatal("replay restarted Chrome")
	}
}
func TestLabBrowserSidecarLostStartIsReadOnlyReconciled(t *testing.T) {
	c, f := sidecarFixture(t)
	f.lostStart = true
	state, err := c.start(context.Background(), f.spec)
	if err != nil || !state.Running || f.starts != 1 {
		t.Fatalf("lost start: %#v %v", state, err)
	}
}
func TestLabBrowserSidecarStopPreservesIdentityAndRecoversLostReply(t *testing.T) {
	c, f := sidecarFixture(t)
	state, err := c.start(context.Background(), f.spec)
	if err != nil {
		t.Fatal(err)
	}
	f.lostStop = true
	if _, err := c.stop(context.Background(), f.spec, state); err == nil {
		t.Fatal("lost stop reply accepted without retry")
	}
	f.lostStop = false
	stopped, err := c.stop(context.Background(), f.spec, state)
	if err != nil || !stopped.Stopped || stopped.Running || stopped.MainPID != state.MainPID || stopped.StartTicks != state.StartTicks || stopped.InvocationID != state.InvocationID || f.stops != 1 {
		t.Fatalf("stop recovery: %#v %v", stopped, err)
	}
	f.phase = "missing"
	again, err := c.stop(context.Background(), f.spec, stopped)
	if err != nil || !again.Stopped || again.MainPID != 4242 || f.stops != 1 {
		t.Fatalf("removed unit replay: %#v %v", again, err)
	}
}
func TestLabBrowserSidecarIntentOnlyMissingUnitMakesNoPIDClaim(t *testing.T) {
	c, f := sidecarFixture(t)
	intent, _ := labBrowserSidecarIntent(f.spec)
	f.gone = true
	stopped, err := c.stop(context.Background(), f.spec, intent)
	if err != nil || !stopped.Stopped || stopped.MainPID != 0 || stopped.ResourcesVerified || f.stops != 0 {
		t.Fatalf("intent cleanup: %#v %v", stopped, err)
	}
}
func TestLabBrowserSidecarRefusesForeignUnitAndProcessBindings(t *testing.T) {
	cases := map[string]func(*sidecarFake){"invocation": func(f *sidecarFake) { f.changes["InvocationID"] = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, "exec": func(f *sidecarFake) { f.changes["ExecStart"] = "foreign" }, "description": func(f *sidecarFake) { f.changes["Description"] = "foreign" }, "resource": func(f *sidecarFake) { f.changes["TasksMax"] = "infinity" }, "no NNP": func(f *sidecarFake) { f.changes["NoNewPrivileges"] = "no" }, "hook": func(f *sidecarFake) { f.changes["ExecStop"] = "dangerous hook" }, "UID": func(f *sidecarFake) { f.procUID = "0" }, "exe": func(f *sidecarFake) { f.procExe = "/bin/sh" }, "argv": func(f *sidecarFake) { f.procArgs = "/bin/sh\x00" }, "cgroup": func(f *sidecarFake) { f.procGroup = "/system.slice/hermes-gateway.service" }, "changed before stop": func(f *sidecarFake) { f.replacedBeforeStop = true }}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			c, f := sidecarFixture(t)
			f.phase = "running"
			state, err := c.inspect(context.Background(), f.spec)
			if err != nil {
				t.Fatal(err)
			}
			change(f)
			if _, err := c.stop(context.Background(), f.spec, state); err == nil {
				t.Fatal("foreign binding accepted")
			}
			if f.stops != 0 {
				t.Fatal("foreign unit was stopped")
			}
		})
	}
}
func TestLabBrowserSidecarInactivityAloneDoesNotProvePIDGone(t *testing.T) {
	c, f := sidecarFixture(t)
	state, err := c.start(context.Background(), f.spec)
	if err != nil {
		t.Fatal(err)
	}
	f.retainPID = true
	if _, err := c.stop(context.Background(), f.spec, state); err == nil {
		t.Fatal("inactive unit with original live PID accepted")
	}
}
func TestLabBrowserSidecarStoppedNonceNeverRestarts(t *testing.T) {
	c, f := sidecarFixture(t)
	f.phase = "inactive"
	f.gone = true
	if _, err := c.start(context.Background(), f.spec); err == nil || f.starts != 0 {
		t.Fatal("inactive owned nonce was restarted")
	}
}
func TestLabBrowserSidecarInvalidSpecAndReceiptNeverMutate(t *testing.T) {
	c, f := sidecarFixture(t)
	bad := f.spec
	bad.Nonce = "../foreign"
	if _, err := c.start(context.Background(), bad); err == nil || len(f.calls) != 0 {
		t.Fatal("invalid nonce reached commands")
	}
	intent, _ := labBrowserSidecarIntent(f.spec)
	intent.ExecFingerprint = "foreign"
	if _, err := c.stop(context.Background(), f.spec, intent); err == nil || len(f.calls) != 0 {
		t.Fatal("foreign receipt reached commands")
	}
}
func TestLabBrowserSidecarStatUsesStartTicksAfterLastParenthesis(t *testing.T) {
	ticks, err := sidecarProcessTicks([]byte("4242 (chrome (main)) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345"))
	if err != nil || ticks != "12345" {
		t.Fatalf("ticks: %q %v", ticks, err)
	}
}

func TestLabBrowserSidecarLostStartWithoutUnitIsNotRetried(t *testing.T) {
	c, f := sidecarFixture(t)
	c.runner = sidecarRunnerFunc(func(ctx context.Context, command exec.Cmd) (exec.Result, error) {
		if slices.Contains(command.Args, "/usr/bin/systemd-run") {
			f.starts++
			return exec.Result{}, errors.New("lost response before unit creation")
		}
		return f.Run(ctx, command)
	})
	if _, err := c.start(context.Background(), f.spec); err == nil || f.starts != 1 {
		t.Fatal("ambiguous start retried or accepted")
	}
}

type sidecarRunnerFunc func(context.Context, exec.Cmd) (exec.Result, error)

func (f sidecarRunnerFunc) Run(ctx context.Context, command exec.Cmd) (exec.Result, error) {
	return f(ctx, command)
}
func TestLabBrowserSidecarUnitAbsentStillRequiresOldProcessGone(t *testing.T) {
	c, f := sidecarFixture(t)
	f.phase = "running"
	state, err := c.inspect(context.Background(), f.spec)
	if err != nil {
		t.Fatal(err)
	}
	f.phase = "missing"
	if _, err := c.stop(context.Background(), f.spec, state); err == nil {
		t.Fatal("unit disappearance hid original live PID")
	}
	if f.stops != 0 {
		t.Fatal("missing unit triggered a signal")
	}
}
func TestLabBrowserSidecarNeverStopsChangedPIDOrUnknownInventory(t *testing.T) {
	c, f := sidecarFixture(t)
	f.phase = "running"
	state, err := c.inspect(context.Background(), f.spec)
	if err != nil {
		t.Fatal(err)
	}
	state.MainPID++
	if _, err := c.stop(context.Background(), f.spec, state); err == nil || f.stops != 0 {
		t.Fatal("changed PID was stopped")
	}
	c.runner = sidecarRunnerFunc(func(context.Context, exec.Cmd) (exec.Result, error) { return exec.Result{ExitCode: 1, Stdout: ""}, nil })
	if _, err := c.stop(context.Background(), f.spec, state); err == nil {
		t.Fatal("unreadable manager was treated as stopped")
	}
}

func TestLabBrowserSidecarAcceptsOmittedEmptyHookArrays(t *testing.T) {
	c, f := sidecarFixture(t)
	f.omitted = map[string]bool{"ExecCondition": true, "ExecStartPre": true, "ExecStartPost": true, "ExecStop": true, "ExecStopPost": true}
	state, err := c.start(context.Background(), f.spec)
	if err != nil || !state.Running || !state.ResourcesVerified {
		t.Fatalf("systemd omitted empty hooks: %#v %v", state, err)
	}
	stopped, err := c.stop(context.Background(), f.spec, state)
	if err != nil || !stopped.Stopped || stopped.MainPID != state.MainPID {
		t.Fatalf("stop with omitted hooks: %#v %v", stopped, err)
	}
}
func TestLabBrowserSidecarIntentCanSettleFailedUnitWithOmittedHooks(t *testing.T) {
	c, f := sidecarFixture(t)
	f.phase = "failed"
	f.gone = true
	f.omitted = map[string]bool{"ExecCondition": true, "ExecStartPre": true, "ExecStartPost": true, "ExecStop": true, "ExecStopPost": true}
	intent, _ := labBrowserSidecarIntent(f.spec)
	state, err := c.stop(context.Background(), f.spec, intent)
	if err != nil || !state.Stopped || state.Running || state.MainPID != 0 || f.stops != 0 {
		t.Fatalf("failed-before-PID cleanup: %#v %v", state, err)
	}
}
func TestLabBrowserSidecarStillRejectsEveryNonemptyHook(t *testing.T) {
	for _, hook := range []string{"ExecCondition", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"} {
		t.Run(hook, func(t *testing.T) {
			c, f := sidecarFixture(t)
			f.phase = "running"
			intent, _ := labBrowserSidecarIntent(f.spec)
			f.changes[hook] = "{ path=/bin/foreign ; argv[]=/bin/foreign ; ignore_errors=no ; }"
			if _, err := c.stop(context.Background(), f.spec, intent); err == nil || f.stops != 0 {
				t.Fatal("nonempty hook granted stop authority")
			}
		})
	}
}
func TestLabBrowserSidecarRequiresEveryOtherInventoryProperty(t *testing.T) {
	hooks := map[string]bool{"ExecCondition": true, "ExecStartPre": true, "ExecStartPost": true, "ExecStop": true, "ExecStopPost": true}
	for _, property := range sidecarProperties {
		if hooks[property] {
			continue
		}
		t.Run(property, func(t *testing.T) {
			c, f := sidecarFixture(t)
			f.phase = "running"
			f.omitted = map[string]bool{property: true}
			if _, err := c.inspect(context.Background(), f.spec); err == nil {
				t.Fatalf("missing required property %s accepted", property)
			}
			if f.starts != 0 || f.stops != 0 {
				t.Fatal("incomplete inventory caused mutation")
			}
		})
	}
}

func TestLabBrowserSidecarLegacyFingerprintIsUnchanged(t *testing.T) {
	_, f := sidecarFixture(t)
	intent, err := labBrowserSidecarIntent(f.spec)
	if err != nil {
		t.Fatal(err)
	}
	if intent.ExecFingerprint != "323e2e7a1bdb172169a82ac3ebb0cc7764ff8074468c5f52d8c05c7d97383ef0" {
		t.Fatalf("legacy fingerprint = %s", intent.ExecFingerprint)
	}
}

func TestLabBrowserSidecarLoggingIsExplicitAndLegacyReceiptsStayCompatible(t *testing.T) {
	c, f := sidecarFixture(t)
	legacy := f.spec
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "logToStderr") {
		t.Fatal("legacy root receipt encoding changed")
	}
	var decoded labBrowserSidecarSpec
	if err := json.Unmarshal(encoded, &decoded); err != nil || decoded.LogToStderr {
		t.Fatal("absent logging flag migrated legacy receipt")
	}
	oldIntent, _ := labBrowserSidecarIntent(decoded)
	if slices.Contains(sidecarBrowserArgs(decoded), "--enable-logging=stderr") {
		t.Fatal("legacy invocation args changed")
	}
	f.spec.LogToStderr = true
	newIntent, err := labBrowserSidecarIntent(f.spec)
	if err != nil {
		t.Fatal(err)
	}
	if oldIntent.ExecFingerprint == newIntent.ExecFingerprint {
		t.Fatal("logging invocation is not bound by fingerprint")
	}
	if !slices.Contains(sidecarBrowserArgs(f.spec), "--enable-logging=stderr") {
		t.Fatal("new logging request omitted stderr flag")
	}
	state, err := c.start(context.Background(), f.spec)
	if err != nil || !state.Running {
		t.Fatalf("logging start: %#v %v", state, err)
	}
	var command string
	for _, call := range f.calls {
		if slices.Contains(call.Args, "/usr/bin/systemd-run") {
			command = call.String()
		}
	}
	if strings.Count(command, "--enable-logging=stderr") != 1 {
		t.Fatalf("stderr logging not exactly once in fixed argv: %s", command)
	}
}

func TestLabBrowserSidecarShortTmpBoundsSocketAndPreservesBothLegacyModes(t *testing.T) {
	_, f := sidecarFixture(t)
	for _, logging := range []bool{false, true} {
		old := f.spec
		old.LogToStderr = logging
		encoded, err := json.Marshal(old)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "shortTmpDir") {
			t.Fatal("legacy receipt encoding changed")
		}
		var roundtrip labBrowserSidecarSpec
		if json.Unmarshal(encoded, &roundtrip) != nil || roundtrip.ShortTmpDir {
			t.Fatal("legacy short-temp flag migrated")
		}
		original, _ := labBrowserSidecarIntent(old)
		restored, _ := labBrowserSidecarIntent(roundtrip)
		if original.ExecFingerprint != restored.ExecFingerprint || labBrowserSidecarTmp(roundtrip) != labBrowserSidecarHome(old)+"/tmp" {
			t.Fatal("legacy argv or ownership fingerprint changed")
		}
		modern := old
		modern.ShortTmpDir = true
		intent, err := labBrowserSidecarIntent(modern)
		if err != nil {
			t.Fatal(err)
		}
		if intent.ExecFingerprint == original.ExecFingerprint {
			t.Fatal("changed TMPDIR not included in ownership binding")
		}
		if !slices.Contains(sidecarExec(modern), "TMPDIR="+labBrowserSidecarTmp(modern)) {
			t.Fatal("short TMPDIR missing from fixed clean environment")
		}
		modern.UID = 4294967295
		if _, err := labBrowserSidecarIntent(modern); err != nil {
			t.Fatal(err)
		}
		socket := labBrowserSidecarTmp(modern) + "/.org.chromium.Chromium.XXXXXX/SingletonSocket"
		if len(socket) > 107 {
			t.Fatalf("Linux sockaddr_un limit exceeded: %d %s", len(socket), socket)
		}
	}
}
