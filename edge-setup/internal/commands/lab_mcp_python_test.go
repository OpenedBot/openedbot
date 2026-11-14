package commands

import (
	osexec "os/exec"
	"strings"
	"testing"
)

func TestLabMCPPythonUsesOnlyOwnedProfileAndPersistsIndependentCalls(t *testing.T) {
	code := `import json, os, sys, tempfile, types
scope={"__name__":"lab_mcp_test","__file__":"/fixed/lab-mcp.py"}
exec(compile(sys.stdin.read(),"lab_mcp_fixture.py","exec"),scope)
with tempfile.TemporaryDirectory() as home:
 scope["ROOT"]=home;scope["yaml_load"]=json.loads;scope["yaml_dump"]=json.dumps
 profile="e2e-owned";nonce="e91f2fdf-daab-49c7-9e61-f638fdaa3074"
 os.makedirs(os.path.join(home,"profiles",profile))
 path=os.path.join(home,"profiles",profile,"config.yaml")
 original={"mcp_servers":{"operator":{"command":"keep-this","enabled":True}},"platform_toolsets":{"api_server":["web","operator"]},"model":{"default":"keep-model"}}
 with open(path,"w") as f:json.dump(original,f)
 root=os.path.join(home,"config.yaml")
 with open(root,"w") as f:f.write("ROOT MUST STAY EXACT")
 request={"nonce":nonce,"profile":profile,"runtimeId":"750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a","serverName":"e2e_"+nonce.replace("-",""),"secret":"MCP_"+"a"*32,"state":"preparing","action":"setup","entryScriptPath":"/fixed/lab-mcp-previous.py"}
 control=scope["control"]
 result=control(request);assert result["installed"] and result["calls"]==[]
 assert control(request)["installed"]
 config=json.load(open(path));assert config["mcp_servers"]["operator"]==original["mcp_servers"]["operator"]
 expected=scope["entry"](nonce,request["entryScriptPath"]);assert scope["bound_entry"](config["mcp_servers"][request["serverName"]],expected)
 state_dir=os.path.join(home,"lab-mcp-fixtures",nonce)
 class FakeMCP:
  def __init__(self,*a,**k):pass
  def tool(self,**options):
   assert options["annotations"].readOnlyHint is True
   def register(fn):self.read_probe=fn;return fn
   return register
  def run(self,**options):
   assert options=={"transport":"stdio"}
   assert self.read_probe("fresh-challenge")==request["secret"]
   control({**request,"state":"installed","action":"offline"})
   try:self.read_probe("unavailable-challenge")
   except ValueError as error:assert str(error)=="E2E_FIXTURE_UNAVAILABLE"
   else:raise AssertionError("offline call succeeded")
   for bad in ["", "../x", "x"*101]:
    try:self.read_probe(bad)
    except ValueError:pass
    else:raise AssertionError("bad challenge accepted")
 for name in ["mcp","mcp.server"]:sys.modules[name]=types.ModuleType(name)
 sys.modules["mcp.server"].MCPServer=FakeMCP
 kinds=types.ModuleType("mcp.types");kinds.ToolAnnotations=lambda **kwargs:types.SimpleNamespace(**kwargs);sys.modules[kinds.__name__]=kinds
 scope["process_ticks"]=lambda pid:"123" if pid==os.getpid() else None
 scope["serve"](nonce)
 snapshot=control({**request,"state":"installed","action":"receipts"})
 assert snapshot["starts"]==1 and snapshot["processes"][0]["running"] is True,snapshot
 assert snapshot["calls"]==[{"challenge":"fresh-challenge","succeeded":True},{"challenge":"unavailable-challenge","succeeded":False}],snapshot
 # A replaced entry is never removed based merely on its generated name.
 config=json.load(open(path));config["mcp_servers"][request["serverName"]]["command"]="foreign-command"
 with open(path,"w") as f:json.dump(config,f)
 try:control({**request,"state":"installed","action":"remove"})
 except ValueError:pass
 else:raise AssertionError("foreign entry removed")
 config["mcp_servers"][request["serverName"]]={**expected,"enabled":False}
 with open(path,"w") as f:json.dump(config,f)
 scope["process_ticks"]=lambda pid:None
 removed=control({**request,"state":"installed","action":"remove"})
 assert not removed["installed"] and not removed["processes"][0]["running"]
 assert os.path.isdir(state_dir),"mutable files removed before root receipt"
 # Inject interruption after every individual unlink and before rmdir.
 saved={name:open(os.path.join(state_dir,name),"rb").read() for name in os.listdir(state_dir)}
 original_unlink=os.unlink;original_rmdir=os.rmdir
 for fail_after in range(1,len(saved)+2):
  if not os.path.exists(state_dir):os.mkdir(state_dir)
  for name,data in saved.items():
   with open(os.path.join(state_dir,name),"wb") as f:f.write(data)
  count=[0]
  def interrupted_unlink(path):
   original_unlink(path);count[0]+=1
   if count[0]==fail_after:raise InterruptedError("injected after unlink")
  def interrupted_rmdir(path):
   if fail_after==len(saved)+1:raise InterruptedError("injected before rmdir")
   original_rmdir(path)
  os.unlink=interrupted_unlink;os.rmdir=interrupted_rmdir
  try:control({**request,**removed,"state":"removing","action":"cleanup"})
  except InterruptedError:pass
  else:raise AssertionError("interruption did not happen")
  finally:os.unlink=original_unlink;os.rmdir=original_rmdir
  resumed=control({**request,**removed,"state":"removing","action":"cleanup"})
  assert resumed["removed"] and resumed["calls"]==removed["calls"] and resumed["processes"]==removed["processes"]
 cleaned=control({**request,**removed,"state":"removing","action":"cleanup"})
 assert cleaned["removed"] and not os.path.exists(state_dir)
 assert control({**request,**removed,"state":"removing","action":"cleanup"})["removed"]
 assert json.load(open(path))==original,json.load(open(path))
 assert open(root).read()=="ROOT MUST STAY EXACT"
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(labMCPFixtureScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("owned MCP fixture Python: %v\n%s", err, output)
	}
}
