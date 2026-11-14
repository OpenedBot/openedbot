package commands

import (
	"context"
	"os"
	osexec "os/exec"
	"strings"
	"testing"
	"time"
)

// Set LAB_MCP_TEST_PYTHON to an isolated interpreter with the exact upstream SDK.
// This test never installs dependencies or reads the host's Hermes profile.
func TestLabMCPPinnedSDKStdioProtocol(t *testing.T) {
	python := os.Getenv("LAB_MCP_TEST_PYTHON")
	if python == "" {
		t.Skip("set LAB_MCP_TEST_PYTHON to Python with mcp==2.3.0 for real STDIO coverage")
	}
	code := `import asyncio, importlib.metadata, json, os, pathlib, sys, tempfile
assert importlib.metadata.version("mcp")=="2.3.0", "test requires Hermes pinned mcp==2.3.0"
from mcp import Client, StdioServerParameters
source=sys.stdin.read()
scope={"__name__":"lab_mcp_test","__file__":"/fixed/lab-mcp.py"}
exec(compile(source,"lab_mcp_fixture.py","exec"),scope)
async def check(home):
 scope["ROOT"]=home;scope["yaml_load"]=json.loads;scope["yaml_dump"]=json.dumps
 profile="e2e-protocol";nonce="e91f2fdf-daab-49c7-9e61-f638fdaa3074"
 os.makedirs(os.path.join(home,"profiles",profile))
 pathlib.Path(home,"profiles",profile,"config.yaml").write_text("{}")
 request={"nonce":nonce,"profile":profile,"runtimeId":"750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a","serverName":"e2e_"+nonce.replace("-",""),"secret":"MCP_"+"a"*32,"state":"preparing","action":"setup"}
 control=scope["control"];assert control(request)["starts"]==0
 fixture=pathlib.Path(home,"fixture.py");fixture.write_text(source)
 bootstrap="import sys; p=sys.argv[1]; s={'__name__':'probe','__file__':p};exec(compile(open(p).read(),p,'exec'),s);s['ROOT']=sys.argv[2];s['serve'](sys.argv[3])"
 params=StdioServerParameters(command=sys.executable,args=["-c",bootstrap,str(fixture),home,nonce],env={"PATH":os.defpath,"HOME":home})
 async with Client(params,read_timeout_seconds=5) as client:
  tools=(await client.list_tools()).tools
  assert [t.name for t in tools]==["read_probe"],tools
  assert tools[0].annotations.read_only_hint is True
  assert tools[0].input_schema["required"]==["challenge"]
  result=await client.call_tool("read_probe",{"challenge":"fresh-native-challenge"})
  assert not result.is_error and result.content[0].text==request["secret"],result
  live=control({**request,"state":"installed","action":"receipts"})
  assert live["starts"]==1 and live["processes"][0]["running"] is True,live
  control({**request,"state":"installed","action":"offline"})
  failed=await client.call_tool("read_probe",{"challenge":"offline-native-challenge"})
  assert failed.is_error and request["secret"] not in str(failed),failed
  malformed=await client.call_tool("read_probe",{"challenge":"../invalid"})
  assert malformed.is_error,malformed
 final=control({**request,"state":"installed","action":"receipts"})
 assert final["calls"]==[{"challenge":"fresh-native-challenge","succeeded":True},{"challenge":"offline-native-challenge","succeeded":False}],final
 assert final["starts"]==1 and not final["processes"][0]["running"],final
 removed=control({**request,"state":"installed","action":"remove"})
 cleaned=control({**request,**removed,"state":"removing","action":"cleanup"})
 assert cleaned["removed"] and not pathlib.Path(home,"lab-mcp-fixtures",nonce).exists()
with tempfile.TemporaryDirectory() as home:asyncio.run(check(home))
`
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := osexec.CommandContext(ctx, python, "-c", code)
	cmd.Stdin = strings.NewReader(string(labMCPFixtureScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("pinned MCP SDK protocol: %v\n%s", err, output)
	}
}
