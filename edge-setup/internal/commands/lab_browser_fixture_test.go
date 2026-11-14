package commands

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

func labBrowserTestDeps(t *testing.T) (labMCPOptions, labBrowserDeps, *int) {
	t.Helper()
	target, guarded, _ := labTestFixture(t)
	count := 0
	configured := false
	started := false
	options := labMCPOptions{Target: target, Action: "setup", Profile: "e2e-browser-owned"}
	boolean := func(value bool) *bool { return &value }
	pin, err := pins.ChromiumFor("linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	asset := hermes.ChromiumAsset{Executable: "/usr/local/lib/hermes-chromium/" + pin.Target + "-" + pin.SHA256 + "/chrome-linux64/chrome", Version: pins.ChromiumVersion, ArchiveSHA256: pin.SHA256, Target: pin.Target}
	deps := labBrowserDeps{SystemDependencies: func(context.Context) error { return nil }, Target: guarded, StateDir: filepath.Join(t.TempDir(), "receipts"), Ensure: func(context.Context) (hermes.ChromiumAsset, error) { count++; return asset, nil }}
	deps.PlanSidecar = func(_ context.Context, nonce string, asset hermes.ChromiumAsset) (labBrowserSidecarSpec, error) {
		return labBrowserSidecarSpec{Nonce: nonce, UID: 1001, Asset: asset}, nil
	}
	var state labBrowserSidecarState
	deps.InspectSidecar = func(_ context.Context, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
		if !started {
			intent, err := labBrowserSidecarIntent(spec)
			intent.Stopped = true
			return intent, err
		}
		return state, nil
	}
	deps.StartSidecar = func(_ context.Context, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
		intent, err := labBrowserSidecarIntent(spec)
		if err != nil {
			return intent, err
		}
		started = true
		intent.InvocationID = strings.Repeat("b", 32)
		intent.MainPID = 4321
		intent.StartTicks = "123"
		intent.Running = true
		intent.ResourcesVerified = true
		state = intent
		return state, nil
	}
	deps.StopSidecar = func(_ context.Context, _ labBrowserSidecarSpec, expected labBrowserSidecarState) (labBrowserSidecarState, error) {
		state = expected
		state.Running = false
		state.Stopped = true
		state.ResourcesVerified = true
		return state, nil
	}
	deps.Run = func(_ context.Context, request map[string]any) (labBrowserWorker, error) {
		switch request["action"] {
		case "prepare":
			return labBrowserWorker{Before: &labBrowserBefore{Fields: map[string]json.RawMessage{}}}, nil
		case "sidecar-prepare":
			return labBrowserWorker{Installed: boolean(false), Removed: boolean(false)}, nil
		case "sidecar-observe":
			return labBrowserWorker{ProbeDiagnostic: &labBrowserProbeDiagnostic{Outcome: "succeeded", CDPReady: true}, CDPURL: "ws://127.0.0.1:43210/devtools/browser/11111111-1111-4111-8111-111111111111"}, nil
		case "sidecar-cleanup", "verify-original":
			return labBrowserWorker{Installed: boolean(false), Removed: boolean(true)}, nil
		case "setup":
			configured = true
		case "remove":
			configured = false
			return labBrowserWorker{Installed: boolean(false), Removed: boolean(true)}, nil
		}
		return labBrowserWorker{Installed: boolean(configured), Removed: boolean(false)}, nil
	}
	return options, deps, &count
}

func TestLabBrowserRefusesNonLabOrArbitraryInputBeforeProvisioning(t *testing.T) {
	options, deps, count := labBrowserTestDeps(t)
	deps.Target.Environment = func(layout.ConnectorInstance, string) (string, error) { return "prod", nil }
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil || *count != 0 {
		t.Fatal("production reached provisioning")
	}
	env := cli.Env{Stdout: io.Discard, Stderr: io.Discard}
	args := []string{"setup", "--schema-version", "2", "--yes", "--allow-lab-fault", "--json", "--name", "lab", "--runtime-id", labTestRuntime, "--nonce", labTestNonce, "--profile", "e2e-browser"}
	if _, err := parseLabBrowser(env, args); err != nil {
		t.Fatal(err)
	}
	if _, err := parseLabBrowser(env, append([]string{args[0]}, args[3:]...)); err == nil {
		t.Fatal("schema v1 caller accepted before mutation")
	}
	for _, suffix := range [][]string{{"--url", "http://x"}, {"--executable", "/bin/sh"}, {"--profile", "default"}, {"--yes=false"}} {
		if _, err := parseLabBrowser(env, append(append([]string{}, args...), suffix...)); err == nil {
			t.Fatal("arbitrary browser control accepted")
		}
	}
}

func TestLabBrowserLostSetupAndVersionUpgradeReconcileWithoutReinstall(t *testing.T) {
	options, deps, count := labBrowserTestDeps(t)
	first, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Installed || !first.PrivateURLException || first.Replayed {
		t.Fatal("setup evidence incomplete")
	}
	// New helper/build must preserve the exact original asset/owned fields.
	deps.Ensure = func(context.Context) (hermes.ChromiumAsset, error) {
		t.Fatal("upgrade replaced an active fixture asset")
		return hermes.ChromiumAsset{}, nil
	}
	again, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || !again.Replayed || again.Executable != first.Executable || *count != 1 {
		t.Fatalf("setup replay: %+v %v", again, err)
	}
	options.Action = "remove"
	removed, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || !removed.Removed || removed.Installed || removed.PrivateURLException {
		t.Fatalf("restore: %+v %v", removed, err)
	}
	deps.Run = func(context.Context, map[string]any) (labBrowserWorker, error) {
		t.Fatal("removed fixture re-entered worker")
		return labBrowserWorker{}, nil
	}
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	options.Action = "setup"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("removed fixture recreated")
	}
}

func TestLabBrowserInterruptedApplyAndRestoreKeepOriginalReceipt(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	original := deps.Run
	fail := true
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		if request["action"] == "setup" && fail {
			_, _ = original(ctx, request)
			return labBrowserWorker{}, errors.New("lost apply response")
		}
		return original(ctx, request)
	}
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("lost apply response accepted")
	}
	fail = false
	options.Action = "receipts"
	reconciled, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || !reconciled.Installed {
		t.Fatalf("lost setup unreconciled: %+v %v", reconciled, err)
	}
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		if request["action"] == "remove" && fail {
			_, _ = original(ctx, request)
			return labBrowserWorker{}, errors.New("lost restore response")
		}
		return original(ctx, request)
	}
	fail = true
	options.Action = "remove"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("lost restore response accepted")
	}
	fail = false
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	options.Target.Nonce = "11111111-1111-4111-8111-111111111111"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("foreign nonce took over profile receipt")
	}
}

func TestLabBrowserPythonRestoresOnlyOwnedFieldsAndRefusesConflict(t *testing.T) {
	code := `import json,os,sys,tempfile
scope={"__name__":"test"};exec(compile(sys.stdin.read(),"browser.py","exec"),scope)
with tempfile.TemporaryDirectory() as home:
 scope["ROOT"]=home;profile="e2e-owned";path=os.path.join(home,"profiles",profile,"config.yaml");os.makedirs(os.path.dirname(path))
 original={"model":"untouched","browser":{"custom":"keep","cloud_provider":"local","allow_private_urls":False}}
 def load(p):return json.loads(scope["read"](p))
 def write(p,c):
  with open(p,"w") as h:json.dump(c,h)
 scope["load"]=load;scope["write"]=write;write(path,original)
 root=os.path.join(home,"config.yaml");open(root,"w").write("ROOT EXACT")
 control=scope["control"];before=control({"action":"prepare","profile":profile})["before"]
 owned={key:None for key in scope["KEYS"]};owned.update(allow_private_urls=True,cloud_provider="local",executable_path="/immutable/chrome")
 request={"action":"setup","profile":profile,"before":before,"owned":owned}
 assert control(request)["installed"]
 assert control({**request,"action":"receipts"})["installed"]
 current=load(path);current["browser"]["custom"]="operator-new";write(path,current)
 # A failed write before atomic replacement is safe to repeat.
 real_write=scope["write"]
 def interrupted(*args):raise InterruptedError("before replacement")
 scope["write"]=interrupted
 try:control({**request,"action":"remove"})
 except InterruptedError:pass
 else:raise AssertionError("expected interruption")
 scope["write"]=real_write
 assert control({**request,"action":"remove"})["removed"]
 assert control({**request,"action":"remove"})["removed"]
 restored=load(path);assert restored["browser"]["custom"]=="operator-new";restored["browser"]["custom"]="keep";assert restored==original
 assert open(root).read()=="ROOT EXACT"
 for prior in [{"model":"alone"},{"browser":{}},{"browser":{"use_gateway":None}}]:
  write(path,prior);prior_before=control({"action":"prepare","profile":profile})["before"]
  local_request={**request,"before":prior_before};control(local_request);control({**local_request,"action":"remove"})
  assert load(path)==prior
 write(path,original)
 control(request);changed=load(path);changed["browser"]["allow_private_urls"]=1;write(path,changed)
 try:control({**request,"action":"remove"})
 except ValueError:pass
 else:raise AssertionError("numeric bool or foreign change restored")
 env=os.path.join(os.path.dirname(path),".env");open(env,"w").write("BROWSER_CDP_URL=hidden-override\n")
 try:control({"action":"prepare","profile":profile})
 except ValueError:pass
 else:raise AssertionError("remote CDP accepted")
`
	command := exec.Command("python3", "-c", code)
	command.Stdin = strings.NewReader(labBrowserProgram)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("browser control: %v\n%s", err, output)
	}
}

func TestLabBrowserProbeCapturesBoundedPrivateDiagnosticsAndReapsChildren(t *testing.T) {
	code := `import os,sys,tempfile,subprocess,signal
scope={"__name__":"test"};exec(compile(sys.stdin.read(),"browser.py","exec"),scope)
with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as readonly:
 os.chmod(readonly,0o500)
 scope["ROOT"]=home;real_popen=scope["subprocess"].Popen;os.environ["HOME"]=readonly;os.environ["APP_SECRET_SENTINEL"]="must-not-inherit"
 for case in ["failure","clean-exit","flood","timeout"]:
  children=[]
  def start(argv,**kwargs):
   assert argv[0]=="/usr/local/lib/hermes-chromium/pinned/chrome" and argv[-1]=="about:blank" and "--no-sandbox" not in argv
   assert kwargs["start_new_session"] is True and kwargs["stderr"]==subprocess.PIPE
   env=kwargs["env"];assert "APP_SECRET_SENTINEL" not in env and env["HOME"]!=readonly
   for key in ["HOME","XDG_CONFIG_HOME","XDG_CACHE_HOME"]:assert os.path.isdir(env[key]) and os.access(env[key],os.W_OK) and env[key].startswith(home)
   if case=="failure":program="import sys;sys.stderr.write('trusted-headless-failure');sys.exit(12)"
   elif case=="clean-exit":program="import sys;sys.exit(0)"
   elif case=="flood":program="import os,sys;os.write(2,b'x'*(3*1024*1024)+b'TAIL_MARKER');sys.exit(7)"
   else:program="import sys,time;sys.stderr.write('probe-timeout\\n');sys.stderr.flush();time.sleep(30)"
   child=real_popen([sys.executable,"-c",program],**kwargs);children.append(child);return child
  scope["subprocess"].Popen=start;scope["PROBE_TIMEOUT_SECONDS"]=0.1 if case=="timeout" else 15
  try:result=scope["control"]({"action":"probe","executable":"/usr/local/lib/hermes-chromium/pinned/chrome","version":"1208+145.0.7632.6"})
  finally:scope["subprocess"].Popen=real_popen
  diagnostic=result["probeDiagnostic"];assert not result["installed"] and not result["removed"] and len(diagnostic["stderrTail"])<=8192
  assert children[0].poll() is not None and os.listdir(home)==[]
  try:os.killpg(children[0].pid,0)
  except ProcessLookupError:pass
  else:raise AssertionError("probe process group not reaped")
  if case=="failure":assert diagnostic["exitCode"]==12 and diagnostic["outcome"]=="failed" and diagnostic["stderrTail"]=="trusted-headless-failure",diagnostic
  if case=="clean-exit":assert diagnostic["exitCode"]==0 and diagnostic["outcome"]=="failed" and not diagnostic["cdpReady"],diagnostic
  if case=="flood":assert diagnostic["exitCode"]==7 and diagnostic["truncated"] and diagnostic["stderrTail"].endswith("TAIL_MARKER"),diagnostic
  if case=="timeout":assert diagnostic["timedOut"] and diagnostic["signal"]==signal.SIGKILL and diagnostic["outcome"]=="timeout",diagnostic
 for bad in ["/bin/sh","/usr/local/lib/hermes-chromium/../../bin/chrome"]:
  try:scope["control"]({"action":"probe","executable":bad})
  except ValueError:pass
  else:raise AssertionError("arbitrary executable accepted")
`
	command := exec.Command("python3", "-c", code)
	command.Stdin = strings.NewReader(labBrowserProgram)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("browser probe: %v\n%s", err, output)
	}
}

func TestLabBrowserSystemDependenciesRunOnlyBeforeOwnedSetupProbe(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	stages := []string{}
	original := deps.Run
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		stages = append(stages, request["action"].(string))
		return original(ctx, request)
	}
	deps.SystemDependencies = func(context.Context) error { stages = append(stages, "apt"); return nil }

	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	if strings.Join(stages, ",") != "prepare,apt,sidecar-prepare,sidecar-ownership,sidecar-observe,setup" {
		t.Fatalf("unsafe ordering %v", stages)
	}
	// Reads, setup replay and restoration never re-run host package changes.
	deps.SystemDependencies = func(context.Context) error {
		t.Fatal("unexpected package mutation outside first owned setup")
		return nil
	}
	options.Action = "receipts"
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	options.Action = "setup"
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	foreign := options
	foreign.Target.Nonce = "11111111-1111-4111-8111-111111111111"
	if _, err := executeLabBrowser(context.Background(), foreign, deps); err == nil {
		t.Fatal("foreign receipt accepted")
	}
	options.Action = "remove"
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
}

func TestLabBrowserDependencyFailureLeavesProfileUnchangedAndReceiptRecoverable(t *testing.T) {
	options, deps, count := labBrowserTestDeps(t)
	original := deps.Run
	applied := false
	aptCalls := 0
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		if request["action"] == "setup" {
			applied = true
		}
		return original(ctx, request)
	}
	deps.SystemDependencies = func(context.Context) error { aptCalls++; return errors.New("fixed package prerequisites unavailable") }

	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil || !strings.Contains(err.Error(), "Chromium system dependencies") {
		t.Fatalf("missing actionable dependency failure: %v", err)
	}
	if applied || *count != 0 || aptCalls != 1 {
		t.Fatalf("profile or browser changed after dependency failure: %v %d %d", applied, *count, aptCalls)
	}
	options.Action = "receipts"
	receipt, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || receipt.Installed || receipt.Removed {
		t.Fatalf("lost preparing receipt: %+v %v", receipt, err)
	}
	options.Action = "remove"
	receipt, err = executeLabBrowser(context.Background(), options, deps)
	if err != nil || !receipt.Removed || aptCalls != 1 {
		t.Fatalf("package failure prevented exact cleanup: %+v %v", receipt, err)
	}
	// Neither absent ownership nor development gate refusal can reach APT.
	options, deps, _ = labBrowserTestDeps(t)
	deps.SystemDependencies = func(context.Context) error { t.Fatal("unowned/non-dev request reached APT"); return nil }
	options.Action = "remove"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("unowned remove accepted")
	}
	options.Action = "setup"
	deps.Target.Environment = func(layout.ConnectorInstance, string) (string, error) { return "prod", nil }
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("production setup accepted")
	}
}

func TestLabBrowserFailureDiagnosticIsPrivateAndDurableBeforeReturning(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	code := 12
	diagnostic := &labBrowserProbeDiagnostic{Outcome: "failed", ExitCode: &code, StderrTail: "trusted about:blank stderr"}
	originalRun := deps.Run
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		if request["action"] == "sidecar-observe" {
			return labBrowserWorker{ProbeDiagnostic: diagnostic}, nil
		}
		return originalRun(ctx, request)
	}
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("failed browser accepted")
	}
	data, err := os.ReadFile(filepath.Join(deps.StateDir, options.Profile+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var receipt labBrowserReceipt
	if json.Unmarshal(data, &receipt) != nil || receipt.LastProbeDiagnostic == nil || receipt.LastProbeDiagnostic.StderrTail != diagnostic.StderrTail || receipt.Before == nil || receipt.Executable == "" {
		t.Fatal("failure lost original snapshot or private diagnostic")
	}
	info, err := os.Stat(filepath.Join(deps.StateDir, options.Profile+".json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("diagnostic receipt is not private")
	}
	options.Action = "receipts"
	reply, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil {
		t.Fatal(err)
	}
	public, err := json.Marshal(reply)
	if err != nil || strings.Contains(string(public), "probeDiagnostic") || strings.Contains(string(public), diagnostic.StderrTail) {
		t.Fatal("public evidence leaked diagnostic")
	}
	for _, bad := range []*labBrowserProbeDiagnostic{nil, {Outcome: "succeeded"}, {Outcome: "failed", ExitCode: &code, StderrTail: strings.Repeat("x", 8193)}, {Outcome: "failed", ExitCode: &code, StderrTail: "\x00"}} {
		if validLabBrowserProbe(bad) {
			t.Fatal("malformed probe diagnostic accepted")
		}
	}
	if !validLabBrowserProbe(diagnostic) {
		t.Fatal("bounded failure evidence refused")
	}
}

func TestLabBrowserReadinessRequiresFreshOwnedPortAndExactPinnedCDP(t *testing.T) {
	code := `import os,sys,tempfile,subprocess,signal,json,threading,http.server,types,stat
scope={"__name__":"test"};exec(compile(sys.stdin.read(),"browser.py","exec"),scope)
path="/devtools/browser/11111111-1111-4111-8111-111111111111";case="ready";requests=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  requests.append(self.path);assert self.path=="/json/version" and not self.headers.get("Authorization") and not self.headers.get("Cookie")
  if case=="redirect":self.send_response(302);self.send_header("Location","http://example.invalid/");self.end_headers();return
  if case=="http-timeout":
   self.send_response(200);self.send_header("Content-Length","4096");self.end_headers();self.wfile.write(b"{");self.wfile.flush();threading.Event().wait(1);return
  value={"Browser":"Chrome/145.0.7632.6","webSocketDebuggerUrl":"ws://127.0.0.1:%d%s"%(self.server.server_port,path)}
  if case=="wrong-version":value["Browser"]="Chrome/144.0.0.1"
  if case=="wrong-port":value["webSocketDebuggerUrl"]="ws://127.0.0.1:1"+path
  if case=="wrong-path":value["webSocketDebuggerUrl"]="ws://127.0.0.1:%d/devtools/browser/22222222-2222-4222-8222-222222222222"%self.server.server_port
  if case=="userinfo":value["webSocketDebuggerUrl"]="ws://user@127.0.0.1:%d%s"%(self.server.server_port,path)
  data=json.dumps(value).encode() if case!="oversize-http" else b'x'*4097
  self.send_response(200);self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
real_popen=scope["subprocess"].Popen;real_fstat=scope["os"].fstat
try:
 with tempfile.TemporaryDirectory() as home:
  scope["ROOT"]=home;scope["PROBE_TIMEOUT_SECONDS"]=2
  # A proxy setting must never capture the readiness request.
  os.environ["http_proxy"]="http://127.0.0.1:1";os.environ["HTTP_PROXY"]="http://127.0.0.1:1"
  for case in ["ready","wrong-version","wrong-port","wrong-path","userinfo","redirect","stale-file","symlink","oversize-file","malformed-file","wrong-owner","oversize-http","http-timeout"]:
   requests.clear();children=[];scope["PROBE_TIMEOUT_SECONDS"]=0.15 if case=="http-timeout" else 2
   def start(argv,**kwargs):
    assert "--headless=new" in argv and "--remote-debugging-port=0" in argv and "--dump-dom" not in argv and "--no-sandbox" not in argv
    child=real_popen([sys.executable,"-c","import time;time.sleep(30)"],**kwargs);children.append(child)
    portfile=os.path.join(kwargs["env"]["HOME"],"DevToolsActivePort")
    content=str(server.server_port)+"\n"+path+"\n"
    if case=="oversize-file":content="x"*257
    if case=="malformed-file":content="0001\nnot-a-browser-path\n"
    if case=="symlink":os.symlink("/dev/null",portfile)
    else:
     with open(portfile,"w") as f:f.write(content)
    if case=="stale-file":os.utime(portfile,ns=(1,1))
    return child
   def wrong_owner(fd):
    value=real_fstat(fd)
    if stat.S_ISREG(value.st_mode):return types.SimpleNamespace(st_mode=value.st_mode,st_uid=os.geteuid()+1,st_size=value.st_size,st_mtime_ns=value.st_mtime_ns)
    return value
   scope["subprocess"].Popen=start
   if case=="wrong-owner":scope["os"].fstat=wrong_owner
   try:result=scope["control"]({"action":"probe","executable":"/usr/local/lib/hermes-chromium/pinned/chrome","version":"1208+145.0.7632.6"})
   finally:scope["subprocess"].Popen=real_popen;scope["os"].fstat=real_fstat
   diagnostic=result["probeDiagnostic"];assert children[0].poll() is not None and os.listdir(home)==[],(case,diagnostic)
   if case!="http-timeout":assert not diagnostic["timedOut"],(case,diagnostic)
   if case=="ready":assert diagnostic["outcome"]=="succeeded" and diagnostic["cdpReady"] and diagnostic["signal"]==signal.SIGKILL,diagnostic
   elif case=="http-timeout":assert diagnostic["outcome"]=="timeout" and diagnostic["timedOut"] and not diagnostic["cdpReady"],diagnostic
   else:assert diagnostic["outcome"]=="failed" and not diagnostic["cdpReady"] and diagnostic["readinessError"],(case,diagnostic)
   if case in ["stale-file","symlink","oversize-file","malformed-file","wrong-owner"]:assert requests==[],(case,requests)
   else:assert requests==["/json/version"],(case,requests)
finally:server.shutdown();server.server_close();thread.join()
`
	command := exec.Command("python3", "-c", code)
	command.Stdin = strings.NewReader(labBrowserProgram)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("browser CDP readiness: %v\n%s", err, output)
	}
}
