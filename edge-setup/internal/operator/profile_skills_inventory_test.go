package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

func TestInventoryProbeProfileSkillsCompleteAndBounded(t *testing.T) {
	code := `import os, pathlib, sys, tempfile
scope={"__name__":"profile_skills_inventory_test"}
exec(compile(sys.stdin.read(),"inventory_probe.py","exec"),scope)
with tempfile.TemporaryDirectory() as home:
 scope["hermes_home"]=lambda:home
 root=pathlib.Path(home,"profiles","scout","skills");root.mkdir(parents=True)
 def skill(name,parent=root):
  directory=parent/name;directory.mkdir(parents=True,exist_ok=True)
  (directory/"SKILL.md").write_text("fixture")
 def refusal(message,name="scout"):
  try:scope["list_profile_skill_names"](name)
  except scope["Refused"] as error:
   assert error.code=="PROFILE_CONFIG_REFUSED" and message in str(error),error
  else:raise AssertionError("partial inventory returned instead of refusal")
 # Create in reverse order and add the regression fixture after 84 existing skills.
 for n in reversed(range(84)):skill("installed-%03d"%n)
 skill("zz-owned-fixture")
 expected=sorted(["installed-%03d"%n for n in range(84)]+["zz-owned-fixture"])
 names=scope["list_profile_skill_names"]("scout")
 assert names==expected and len(names)==85,names
 flags=scope["profile_skill_flags"]("scout",{"disabled_skills":["zz-owned-fixture"]})
 assert flags==[{"name":n,"enabled":n!="zz-owned-fixture"} for n in expected],flags
 # Hidden trees and symlinked trees never contribute or escape the profile.
 skill("hidden",root/".hidden")
 outside=pathlib.Path(home,"outside");skill("foreign",outside)
 (root/"linked").symlink_to(outside,target_is_directory=True)
 assert scope["list_profile_skill_names"]("scout")==expected
 # Duplicate basenames do not consume the unique-skill limit.
 skill("zz-owned-fixture",root/"category")
 assert scope["list_profile_skill_names"]("scout")==expected
 for n in range(85,256):skill("boundary-%03d"%n)
 assert len(scope["list_profile_skill_names"]("scout"))==256
 skill("overflow")
 refusal("256 skill limit")
 (root/"overflow"/"SKILL.md").unlink();(root/"overflow").rmdir()
 # Count every visited directory, including categories without a manifest.
 scan=pathlib.Path(home,"profiles","scan","skills");scan.mkdir(parents=True)
 for n in range(1023):(scan/("category-%04d"%n)).mkdir()
 assert scope["list_profile_skill_names"]("scan")==[]
 (scan/"one-too-many").mkdir()
 refusal("directory scan limit","scan")
 # A traversal failure must not turn into a successful incomplete inventory.
 walk=os.walk
 def denied(*args,**kwargs):
  kwargs["onerror"](PermissionError("private path must not leak"))
  return iter(())
 os.walk=denied
 try:refusal("check skill directory permissions")
 finally:os.walk=walk
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("profile skills inventory: %v\n%s", err, output)
	}
}
