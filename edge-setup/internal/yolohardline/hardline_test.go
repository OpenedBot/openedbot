package yolohardline

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The embedded copy is the shared contract, byte for byte.
func TestEmbeddedCopyMatchesTheGolden(t *testing.T) {
	golden, err := os.ReadFile(filepath.Join("..", "..", "test", "golden", "yolo-hardline", "hardline.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(golden, JSON) {
		t.Fatal("internal/yolohardline/hardline.json differs from test/golden/yolo-hardline/hardline.json: copy the golden")
	}
}

// Every case of the shared fixture gets the verdict openedbot's TS gives it.
func TestSharedCases(t *testing.T) {
	var doc struct {
		Cases []struct {
			Kind, Input, Expect string
		} `json:"cases"`
	}
	if err := json.Unmarshal(JSON, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) < 40 {
		t.Fatalf("only %d cases", len(doc.Cases))
	}
	for _, c := range doc.Cases {
		var s Subject
		switch c.Kind {
		case "command":
			s = Subject{Command: c.Input, HasCommand: true}
		case "path":
			s = Subject{Paths: []string{c.Input}}
		case "tool":
			s = Subject{ToolKey: c.Input}
		default:
			t.Fatalf("unknown case kind %q", c.Kind)
		}
		got := "allowed"
		if id := Hardline(s); id != "" {
			got = "hardline:" + id
		} else if id := Protection(s, nil); id != "" {
			got = "protected:" + id
		}
		if got != c.Expect {
			t.Errorf("%s %q: got %s, want %s", c.Kind, c.Input, got, c.Expect)
		}
	}
}

func TestBlockOrderAndDenyList(t *testing.T) {
	deny := Deny{Commands: []string{"git push --force"}, Tools: []string{"send_message"}, Paths: []string{".aws"}}
	cases := []struct {
		name string
		s    Subject
		want string
	}{
		{"plain write", Subject{ToolKey: "write_file", Paths: []string{"/tmp/x.txt"}}, ""},
		{"hardline first", Subject{ToolKey: "cronjob"}, "hardline:tool:cronjob"},
		{"denied tool", Subject{ToolKey: "send_message"}, "denied"},
		{"denied path component", Subject{ToolKey: "write_file", Paths: []string{"/home/me/.aws/config"}}, "denied"},
		{"not a substring", Subject{ToolKey: "write_file", Paths: []string{"my.aws.txt"}}, ""},
		{"denied command past sudo", Subject{Command: "cd x && sudo git push --force origin", HasCommand: true}, "denied"},
		{"other git push", Subject{Command: "git push origin", HasCommand: true}, ""},
		{"unreadable command", Subject{Command: "echo 'unclosed", HasCommand: true}, "unreadable"},
		{"protected path", Subject{ToolKey: "write_file", Paths: []string{"app/.env"}}, "protected:env"},
		{"terminal widening the lease", Subject{Command: "echo '{}' > ~/.hermes/profiles/dev/plugins/ohb_approval_policy/yolo.json", HasCommand: true}, "hardline:approval_plugin"},
		{"terminal touching yolo state", Subject{Command: "cp x /var/lib/hermes-connector/yolo-leases.json", HasCommand: true}, "hardline:yolo_state"},
	}
	for _, c := range cases {
		if got := Block(c.s, DefaultProtect(), deny); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	// Without a command list an unreadable command is not a deny-list hit.
	if got := Block(Subject{Command: "echo 'x", HasCommand: true}, nil, Deny{}); got != "" {
		t.Errorf("unreadable without list: %q", got)
	}
}

func TestDefaultProtectIsKnown(t *testing.T) {
	for _, id := range DefaultProtect() {
		if !IsProtectionID(id) {
			t.Errorf("%s has no rules", id)
		}
	}
	if IsProtectionID("Keychain") {
		t.Error("ids are exact")
	}
}
