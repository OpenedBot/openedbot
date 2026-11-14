package commands

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

func TestLabBrowserV2LostStartAndStopRepliesKeepIdentityAndResumeCleanup(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	originalStart, originalStop, originalRun := deps.StartSidecar, deps.StopSidecar, deps.Run
	starts := 0
	lostStart := true
	lostStop := true
	lostFiles := true
	deps.StartSidecar = func(ctx context.Context, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
		starts++
		data, err := os.ReadFile(filepath.Join(deps.StateDir, options.Profile+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var receipt labBrowserReceipt
		if json.Unmarshal(data, &receipt) != nil || receipt.SidecarSpec == nil || receipt.SidecarState == nil || receipt.SidecarState.ExecFingerprint == "" || receipt.SidecarRequestedAtNS <= 0 {
			t.Fatal("start crossed boundary before durable ownership intent")
		}
		state, err := originalStart(ctx, spec)
		if lostStart {
			lostStart = false
			return state, errors.New("lost start response")
		}
		return state, err
	}
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("lost start response accepted")
	}
	options.Action = "receipts"
	preparing, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || preparing.Installed || preparing.Sidecar == nil || !preparing.Sidecar.Active {
		t.Fatalf("lost launch ownership unreadable: %+v %v", preparing, err)
	}
	options.Action = "setup"
	active, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || starts != 1 || active.SchemaVersion != 2 || active.Placement != "user-unit" || active.Sidecar == nil || !active.Sidecar.ResourcesVerified || active.ConfigRestored {
		t.Fatalf("resume started another process or lacked proof: %+v %v starts%d", active, err, starts)
	}
	public, _ := json.Marshal(active)
	if strings.Contains(string(public), "ws://") || strings.Contains(string(public), "cdpUrl") {
		t.Fatal("public CDP address exposed")
	}
	deps.StopSidecar = func(ctx context.Context, spec labBrowserSidecarSpec, expected labBrowserSidecarState) (labBrowserSidecarState, error) {
		data, _ := os.ReadFile(filepath.Join(deps.StateDir, options.Profile+".json"))
		var receipt labBrowserReceipt
		if json.Unmarshal(data, &receipt) != nil || !receipt.ConfigRestored || receipt.Phase != "removing" {
			t.Fatal("stop preceded durable configuration restoration")
		}
		stopped, err := originalStop(ctx, spec, expected)
		if lostStop {
			lostStop = false
			return stopped, errors.New("lost stop response")
		}
		return stopped, err
	}
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		if request["action"] == "sidecar-cleanup" && lostFiles {
			lostFiles = false
			return labBrowserWorker{}, errors.New("interrupted file cleanup")
		}
		return originalRun(ctx, request)
	}
	options.Action = "remove"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("lost stop response accepted")
	}
	options.Action = "receipts"
	partial, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || !partial.ConfigRestored || partial.Removed || partial.Installed {
		t.Fatalf("partial restoration hidden: %+v %v", partial, err)
	}
	options.Action = "remove"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("incomplete payload deletion accepted")
	}
	removed, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || !removed.Removed || !removed.ConfigRestored || removed.Sidecar == nil || !removed.Sidecar.Stopped || removed.Sidecar.Active {
		t.Fatalf("removal incomplete: %+v %v", removed, err)
	}
	if removed.Sidecar.PID != active.Sidecar.PID || removed.Sidecar.InvocationID != active.Sidecar.InvocationID || removed.Sidecar.StartTicks != active.Sidecar.StartTicks {
		t.Fatal("cleanup changed the owned process identity")
	}
}

func TestLabBrowserV2RefusesForeignUnitAndNeverDeletesStateOnFailedStop(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	originalRun := deps.Run
	filesTouched := false
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		if request["action"] == "sidecar-cleanup" {
			filesTouched = true
		}
		return originalRun(ctx, request)
	}
	deps.StopSidecar = func(context.Context, labBrowserSidecarSpec, labBrowserSidecarState) (labBrowserSidecarState, error) {
		return labBrowserSidecarState{}, errors.New("foreign InvocationID refuses stop")
	}
	options.Action = "remove"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil || filesTouched {
		t.Fatal("foreign stop failure deleted state or became green")
	}
}

func TestLabBrowserSidecarStateCleanupRetainsMarkerUntilPayloadIsGone(t *testing.T) {
	code := `import os,sys,tempfile,json,time,types
scope={"__name__":"test"};exec(compile(sys.stdin.read(),"browser.py","exec"),scope)
with tempfile.TemporaryDirectory() as home:
 scope["ROOT"]=home;request={"action":"sidecar-prepare","profile":"e2e-owned","nonce":"e91f2fdf-daab-49c7-9e61-f638fdaa3074","runtimeId":"750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a"};control=scope["control"]
 state=os.path.join(home,"lab-browser-fixtures",request["nonce"])
 control(request);control(request)
 for suffix in ["home/config","home/cache","home/tmp","home/userdata"]:assert os.path.isdir(os.path.join(state,suffix))
 marker=os.path.join(state,".owner.json");identity=json.load(open(marker))
 foreign={**identity,"profile":"e2e-foreign"};open(marker,"w").write(json.dumps(foreign))
 try:control({**request,"action":"sidecar-cleanup","stopped":True})
 except ValueError:pass
 else:raise AssertionError("foreign state removed")
 assert os.path.isdir(state);open(marker,"w").write(json.dumps(identity))
 try:control({**request,"action":"sidecar-cleanup","stopped":False})
 except ValueError:pass
 else:raise AssertionError("live state removed")
 original_unlink=os.unlink;original_rmdir=os.rmdir
 for phase in ["payload","marker","rmdir"]:
  control(request);open(os.path.join(state,"home","userdata","payload"),"w").write("owned")
  failed=[False]
  def unlink(path,*args,**kwargs):
   original_unlink(path,*args,**kwargs)
   if not failed[0] and ((phase=="marker" and path==marker) or (phase=="payload" and os.path.basename(path)=="payload")):
    failed[0]=True;raise InterruptedError("injected after unlink")
  def rmdir(path,*args,**kwargs):
   if phase=="rmdir" and path==state and not failed[0]:failed[0]=True;raise InterruptedError("injected before final rmdir")
   original_rmdir(path,*args,**kwargs)
  os.unlink=unlink;os.rmdir=rmdir
  try:
   try:control({**request,"action":"sidecar-cleanup","stopped":True})
   except InterruptedError:pass
   else:raise AssertionError("cleanup interruption not injected")
  finally:os.unlink=original_unlink;os.rmdir=original_rmdir
  assert failed[0]
  assert control({**request,"action":"sidecar-cleanup","stopped":True})["removed"] and not os.path.exists(state)
  assert control({**request,"action":"sidecar-cleanup","stopped":True})["removed"]
 # Missing ownership after mkdir is resumable only for empty/pre-marker state.
 os.mkdir(state);open(os.path.join(state,".owner.json.tmp"),"w").write(json.dumps(identity))
 control(request);assert json.load(open(marker))==identity
 control({**request,"action":"sidecar-cleanup","stopped":True})
`
	command := exec.Command("python3", "-c", code)
	command.Stdin = strings.NewReader(labBrowserProgram)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("sidecar state recovery: %v\n%s", err, output)
	}
}

func TestLabBrowserV2CannotAdoptReplacedInvocationOnReceiptsOrSetup(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	inspect := deps.InspectSidecar
	deps.InspectSidecar = func(ctx context.Context, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
		state, err := inspect(ctx, spec)
		state.InvocationID = strings.Repeat("c", 32)
		return state, err
	}
	for _, action := range []string{"receipts", "setup"} {
		options.Action = action
		if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
			t.Fatal("replacement incarnation adopted into durable ownership")
		}
	}
}

func TestLabBrowserV2RemovesLegacyV1ReceiptWithoutStartingAUnit(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	// A failed older binary can leave its original direct-local patch. Its
	// private v1 snapshot remains sufficient for exact restoration only.
	if err := os.Mkdir(deps.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	receipt := labBrowserReceipt{SchemaVersion: 1, RuntimeID: options.Target.RuntimeID, Nonce: options.Target.Nonce, Profile: options.Profile, Phase: "installed", Before: &labBrowserBefore{Fields: map[string]json.RawMessage{}}, Owned: map[string]any{"allow_private_urls": true}}
	path := filepath.Join(deps.StateDir, options.Profile+".json")
	if err := saveLabBrowser(path, receipt, deps.Target.Owner); err != nil {
		t.Fatal(err)
	}
	deps.PlanSidecar = func(context.Context, string, hermes.ChromiumAsset) (labBrowserSidecarSpec, error) {
		t.Fatal("legacy cleanup created a sidecar")
		return labBrowserSidecarSpec{}, nil
	}
	options.Action = "remove"
	out, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || out.SchemaVersion != 2 || !out.Removed || !out.ConfigRestored || out.Sidecar != nil {
		t.Fatalf("legacy v1 cleanup lost compatibility: %+v %v", out, err)
	}
}

func TestLabBrowserMissingProfileStillRequiresOwnedUnitStopAndPayloadCleanup(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	originalRun, originalStop := deps.Run, deps.StopSidecar
	stopped, cleaned := false, false
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		if request["action"] == "remove" {
			no, yes := false, true
			return labBrowserWorker{Installed: &no, Removed: &yes, ProfileAbsent: true}, nil
		}
		if request["action"] == "sidecar-cleanup" {
			if !stopped {
				t.Fatal("profile absence skipped the owned service stop")
			}
			cleaned = true
		}
		return originalRun(ctx, request)
	}
	deps.StopSidecar = func(ctx context.Context, spec labBrowserSidecarSpec, state labBrowserSidecarState) (labBrowserSidecarState, error) {
		stopped = true
		return originalStop(ctx, spec, state)
	}
	options.Action = "remove"
	out, err := executeLabBrowser(context.Background(), options, deps)
	if err != nil || !out.Removed || !out.ConfigRestored || !stopped || !cleaned || out.Sidecar == nil || !out.Sidecar.Stopped {
		t.Fatalf("absent profile bypassed service cleanup: %+v %v", out, err)
	}
}

func TestLabBrowserProfileAbsenceAndReplacementCannotCreateOrOverwriteProfiles(t *testing.T) {
	code := `import os,sys,tempfile,json,shutil
scope={"__name__":"test"};exec(compile(sys.stdin.read(),"browser.py","exec"),scope)
with tempfile.TemporaryDirectory() as home:
 scope["ROOT"]=home;profile="e2e-owned";directory=os.path.join(home,"profiles",profile);os.makedirs(directory);path=os.path.join(directory,"config.yaml")
 original={"browser":{"cloud_provider":"local","allow_private_urls":False},"model":"unchanged"}
 scope["load"]=lambda p:json.loads(scope["read"](p))
 def write(p,c):
  with open(p,"w") as f:json.dump(c,f)
 scope["write"]=write;write(path,original);control=scope["control"]
 before=control({"action":"prepare","profile":profile})["before"];assert before["directoryIdentity"]["inode"]>0
 owned={key:None for key in scope["KEYS"]};owned.update(allow_private_urls=True,cloud_provider="local",executable_path="/immutable/chrome")
 request={"action":"setup","profile":profile,"before":before,"owned":owned};control(request)
 # Keep the old directory alive under another name, guaranteeing a distinct
 # inode for a replacement at the same profile slug.
 retired=directory+"-retired";os.rename(directory,retired);os.mkdir(directory);write(path,original)
 for action in ["setup","receipts","remove","verify-original"]:
  try:control({**request,"action":action})
  except ValueError:pass
  else:raise AssertionError("replacement profile accepted for "+action)
 assert json.load(open(path))==original
 shutil.rmtree(directory);os.rename(retired,directory)
 # The target genuinely disappearing is idempotent cleanup, not permission
 # to create a profile or restore a stale backup into a different scope.
 shutil.rmtree(directory)
 for action in ["remove","verify-original","receipts"]:
  result=control({**request,"action":action});assert result["profileAbsent"] and not result["installed"]
  assert result["removed"]==(action!="receipts") and not os.path.lexists(directory)
 # Existing but incomplete/symlinked profile paths are never absence proof.
 # Linux may hand the recreated directory the old inode back: it then reads as
 # the same directory missing its config (FileNotFoundError), still a refusal.
 os.mkdir(directory)
 try:control({**request,"action":"remove"})
 except (ValueError,FileNotFoundError):pass
 else:raise AssertionError("replaced incomplete directory accepted")
 assert os.path.isdir(directory) and not os.path.lexists(path)
 os.rmdir(directory);os.symlink(os.path.join(home,"missing-target"),directory)
 try:control({**request,"action":"remove"})
 except ValueError:pass
 else:raise AssertionError("dangling profile symlink treated as absent")
 os.unlink(directory)
 # Legacy private v1 snapshots still remove by exact owned fields.
 os.mkdir(directory);write(path,original);legacy={key:value for key,value in before.items() if key!="directoryIdentity"}
 assert control({**request,"action":"remove","before":legacy})["removed"]
 # A missing config inside the same directory must fail, without inventing
 # profile absence or recreating config.yaml.
 fresh=control({"action":"prepare","profile":profile})["before"];os.unlink(path)
 try:control({**request,"action":"remove","before":fresh})
 except FileNotFoundError:pass
 else:raise AssertionError("existing directory's missing config treated as absent")
 assert not os.path.exists(path)
`
	command := exec.Command("python3", "-c", code)
	command.Stdin = strings.NewReader(labBrowserProgram)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("profile absence ownership: %v\n%s", err, output)
	}
}

func TestLabBrowserMarkerBindingPreventsForeignNonceUnitAdoptionAndStop(t *testing.T) {
	options, deps, _ := labBrowserTestDeps(t)
	if _, err := executeLabBrowser(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	original := deps.Run
	stops := 0
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		if request["action"] == "sidecar-ownership" {
			return labBrowserWorker{}, errors.New("nonce state belongs to another profile")
		}
		return original(ctx, request)
	}
	deps.StopSidecar = func(context.Context, labBrowserSidecarSpec, labBrowserSidecarState) (labBrowserSidecarState, error) {
		stops++
		return labBrowserSidecarState{}, nil
	}
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("foreign marker was adopted on setup replay")
	}
	options.Action = "receipts"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil {
		t.Fatal("foreign marker was adopted by a read-only observation")
	}
	options.Action = "remove"
	if _, err := executeLabBrowser(context.Background(), options, deps); err == nil || stops != 0 {
		t.Fatal("foreign marker permitted stopping another fixture's unit")
	}
}

func TestLabBrowserShortTmpOwnershipAndBothDirectoryCleanupResume(t *testing.T) {
	code := `import os,sys,tempfile,json,types,stat,socket
scope={"__name__":"test"};exec(compile(sys.stdin.read(),"browser.py","exec"),scope)
with tempfile.TemporaryDirectory(prefix="ob-",dir="/tmp") as runtime_root, tempfile.TemporaryDirectory() as home:
 scope["ROOT"]=home;scope["RUNTIME_ROOT"]=runtime_root
 user=os.path.join(runtime_root,str(os.geteuid()));os.mkdir(user,0o700)
 request={"action":"sidecar-prepare","profile":"e2e-owned","nonce":"e91f2fdf-daab-49c7-9e61-f638fdaa3074","runtimeId":"750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a","shortTmpDir":True}
 state=os.path.join(home,"lab-browser-fixtures",request["nonce"]);short=os.path.join(user,"ob-"+request["nonce"].replace("-",""))
 actual_lstat=os.lstat
 def fake_parent_owner(path,*args,**kwargs):
  info=actual_lstat(path,*args,**kwargs)
  if path in (runtime_root,os.path.dirname(runtime_root)):
   return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0)
  return info
 os.lstat=fake_parent_owner
 try:
  control=scope["control"];control(request);control(request)
  for path in [state,short]:assert json.load(open(os.path.join(path,".owner.json")))["profile"]==request["profile"]
  assert len((short+"/.org.chromium.Chromium.XXXXXX/SingletonSocket").encode())<=107
  short_scope=os.path.join(short,".org.chromium.Chromium.XXXXXX");os.mkdir(short_scope)
  channel=socket.socket(socket.AF_UNIX)
  try:channel.bind(os.path.join(short_scope,"SingletonSocket"))
  finally:channel.close()
  legacy_scope=os.path.join(state,"home","tmp",".org.chromium.Chromium.XXXXXX");os.mkdir(legacy_scope)
  legacy_socket=os.path.join(legacy_scope,"SingletonSocket");assert len(legacy_socket.encode())>107
  channel=socket.socket(socket.AF_UNIX)
  try:
   try:channel.bind(legacy_socket)
   except OSError:pass
   else:raise AssertionError("deep legacy TMPDIR unexpectedly accepted AF_UNIX socket")
  finally:channel.close()
  marker=os.path.join(short,".owner.json");identity=json.load(open(marker))
  open(marker,"w").write(json.dumps({**identity,"profile":"e2e-foreign"}))
  for action in ["sidecar-prepare","sidecar-ownership","sidecar-cleanup"]:
   try:control({**request,"action":action,"stopped":True})
   except ValueError:pass
   else:raise AssertionError("foreign short marker accepted for "+action)
  assert os.path.exists(os.path.join(state,".owner.json"));open(marker,"w").write(json.dumps(identity))
  # Existing markerless payload is foreign, not an ownership claim by name.
  control({**request,"action":"sidecar-cleanup","stopped":True})
  os.mkdir(short,0o700);open(os.path.join(short,"foreign"),"w").write("untouched")
  try:control(request)
  except ValueError:pass
  else:raise AssertionError("foreign short directory adopted")
  os.unlink(os.path.join(short,"foreign"));os.rmdir(short)
  original_unlink=os.unlink;original_rmdir=os.rmdir
  for directory in [short,state]:
   for phase in ["payload","marker","rmdir"]:
    control(request)
    open(os.path.join(short,"payload"),"w").write("owned")
    open(os.path.join(state,"home","payload"),"w").write("owned")
    failed=[False]
    def unlink(path,*args,**kwargs):
     original_unlink(path,*args,**kwargs)
     target_marker=os.path.join(directory,".owner.json")
     is_payload=path==os.path.join(short,"payload") if directory==short else os.path.basename(path)=="payload" and kwargs.get("dir_fd") is not None
     if not failed[0] and ((phase=="marker" and path==target_marker) or (phase=="payload" and is_payload)):
      failed[0]=True;raise InterruptedError("after own unlink")
    def rmdir(path,*args,**kwargs):
     if not failed[0] and phase=="rmdir" and path==directory:failed[0]=True;raise InterruptedError("before own rmdir")
     original_rmdir(path,*args,**kwargs)
    os.unlink=unlink;os.rmdir=rmdir
    try:
     try:control({**request,"action":"sidecar-cleanup","stopped":True})
     except InterruptedError:pass
     else:raise AssertionError("interruption not reached: "+directory+" "+phase)
    finally:os.unlink=original_unlink;os.rmdir=original_rmdir
    assert failed[0]
    assert control({**request,"action":"sidecar-cleanup","stopped":True})["removed"]
    assert not os.path.lexists(short) and not os.path.lexists(state)
  # A symlink or unsafe user-runtime permissions never become owned state.
  os.symlink(home,short)
  try:control(request)
  except ValueError:pass
  else:raise AssertionError("short directory symlink adopted")
  os.unlink(short)
  # Temporary markers need a complete matching identity before reuse OR
  # cleanup. Bad bytes and each independently wrong identity field survive.
  os.mkdir(short,0o700)
  for payload in ["partial",json.dumps({**identity,"profile":"e2e-foreign"}),json.dumps({**identity,"runtimeId":"foreign"}),json.dumps({**identity,"nonce":"foreign"})]:
   temporary=os.path.join(short,".owner.json.tmp");open(temporary,"w").write(payload)
   for action in ["sidecar-prepare","sidecar-cleanup"]:
    try:control({**request,"action":action,"stopped":True})
    except ValueError:pass
    else:raise AssertionError("ambiguous temporary marker adopted for "+action)
    assert open(temporary).read()==payload
   os.unlink(temporary)
  open(os.path.join(short,".owner.json.tmp"),"w").write(json.dumps(identity))
  control(request);assert json.load(open(os.path.join(short,".owner.json")))==identity
  control({**request,"action":"sidecar-cleanup","stopped":True})
  os.chmod(user,0o755)
  try:control(request)
  except ValueError:pass
  else:raise AssertionError("unsafe runtime parent accepted")
  os.chmod(user,0o700)
 finally:os.lstat=actual_lstat
`
	command := exec.Command("python3", "-c", code)
	command.Stdin = strings.NewReader(labBrowserProgram)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("short temp ownership: %v\n%s", err, output)
	}
}
