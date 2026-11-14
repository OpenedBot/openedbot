package operator

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestApprovalPolicyIdentifiesOnlySingleAdvertisedSkillCreate(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal("python3 is required to validate the approval plugin")
	}
	plugin, err := approvalPolicyFiles.ReadFile("approval_policy_plugin/__init__.py")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "plugin.py")
	if err := os.WriteFile(path, plugin, 0o600); err != nil {
		t.Fatal(err)
	}
	program := `import copy,hashlib,importlib.util,json,pathlib,sys,types
path=pathlib.Path(sys.argv[1]); spec=importlib.util.spec_from_file_location('plugin',path);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
(path.parent/'policy.json').write_text(json.dumps({'mode':'ask_writes'}))
ctx=types.SimpleNamespace(register_hook=lambda name,fn:setattr(ctx,'hook',fn));mod.register(ctx)
content='---\nname: e2e-owned\ndescription: Test\n---\nsecret-content-not-in-descriptor'
operation={'action':'create','name':'e2e-owned','content':content}
args={'operations':[operation]};original=copy.deepcopy(args)
result=ctx.hook('skill_manage',args=args)
assert args==original,'normalization mutated original arguments'
assert result['action']=='approve' and result['rule_key']=='openedbot/v1/skill_manage'
line=result['message'].splitlines()[-1];prefix,line_hash,text=line.split(' ',2);descriptor=json.loads(text)
assert prefix=='openedbot-gate/v1' and hashlib.sha256(text.encode()).hexdigest()==line_hash
assert descriptor=={'v':1,'tool':'skill_manage','deletes':'no','opaque':False,'digest':mod._args_digest(original),'args':{'action':'create','name':'e2e-owned'}}
assert descriptor['digest']!=mod._args_digest(descriptor['args'])
assert content not in result['message'] and 'secret-content' not in result['message']
changed=copy.deepcopy(args);changed['operations'][0]['content']+=' another private byte'
assert mod._args_digest(changed)!=descriptor['digest'],'full content must remain fingerprint-bound'
legacy={'action':'create','name':'e2e-owned','content':content}
assert mod.describe('skill_manage',legacy)==('skill_manage','no',False,{'action':'create','name':'e2e-owned'})
invalid=[{'operations':[]},{'operations':[operation,operation]},{'operations':'not-list'},
 {'operations':[None]},{'operations':[{'action':'delete','name':'e2e-owned','content':content}]},
 {'operations':[{'action':'patch','name':'e2e-owned','content':content}]},
 {**args,'action':'delete'},{**args,'name':'foreign'},{**args,'content':'metadata overwrite'},
 {**args,'rule_key':'forged'}, {**args,'digest':'forged'}]
for field,value in [('category','safe'),('category','../foreign'),('category','/foreign'),('category',''),('category',None),('file_path','../foreign'),('path','/foreign'),('operations',[]),('absorbed_into','foreign'),('digest','forged'),('v',1)]:
 invalid.append({'operations':[{**operation,field:value}]})
for patch in [{'name':'../foreign'},{'name':'/foreign'},{'name':'UPPER'},{'name':'x'*65},{'content':None},{'content':''},{'content':'x'*100001}]:
 invalid.append({'operations':[{**operation,**patch}]})
for payload in invalid:
 result=ctx.hook('skill_manage',args=payload)
 assert result['action']=='approve' and 'rule_key' not in result and 'openedbot-gate/' not in result['message'],'unproven batch acquired identity'
(path.parent/'policy.json').write_text(json.dumps({'mode':'ask_writes','blocked_tools':['skill_manage']}))
assert ctx.hook('skill_manage',args=args)['action']=='block','identified batch must obey blocked tool policy'
`
	cmd := exec.Command(python, "-c", program, path)
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1")
	cmd.Stdin = strings.NewReader("")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("single-operation skill descriptor contract: %v\n%s", err, output)
	}
}
