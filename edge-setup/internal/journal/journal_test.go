package journal

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRedactMasksSecretsAndKeepsPaths(t *testing.T) {
	for in, want := range map[string]string{
		"Authorization: Bearer abc.def-ghi":                                               "Authorization: Bearer [redacted]",
		"ticket 3f2504e0-4f89-11d3-9a0c-0305e82c3301.aaaaaaaaaaaaaaaa used":               "ticket [redacted-ticket] used",
		"API_SERVER_KEY=0123456789abcdef":                                                 "API_SERVER_KEY=[redacted]",
		"openai_api_key: sk-short":                                                        "openai_api_key: [redacted]",
		"key sk-ant-api03-" + strings.Repeat("Ab9", 20):                                   "key sk-ant-api03-[redacted]",
		"https://user:pw@example.com/x":                                                   "https://[redacted]@example.com/x",
		"P1 self-install → /usr/local/lib/hermes-setup/edge-setup":                        "P1 self-install → /usr/local/lib/hermes-setup/edge-setup",
		"restarted hermes-connector@preprod runtime=529da919-36a6-435e-bfe0-f9cb10242702": "restarted hermes-connector@preprod runtime=529da919-36a6-435e-bfe0-f9cb10242702",
	} {
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

func records(t *testing.T, path string) []Record {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []Record
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var r Record
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatalf("%q: %v", sc.Text(), err)
		}
		out = append(out, r)
	}
	return out
}

func TestJournalRecordsRedactedLinesOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	j, err := Open(path, "link", "v1.2.3", []string{"--openedbot", "https://link.example", "--yes"})
	if err != nil {
		t.Fatal(err)
	}
	var shown strings.Builder
	out := j.Tee(&shown, "out")
	_, _ = out.Write([]byte("\x1b[32mlinking\x1b[0m with link.example\npartial "))
	_, _ = out.Write([]byte("token=" + strings.Repeat("z", 40) + "\n"))
	_, _ = out.Write([]byte("[==   ] P1\r[==== ] P2\n"))
	j.Close(0)
	if shown.String() != "\x1b[32mlinking\x1b[0m with link.example\npartial token="+strings.Repeat("z", 40)+"\n[==   ] P1\r[==== ] P2\n" {
		t.Fatalf("the terminal did not get the output untouched: %q", shown.String())
	}
	rs := records(t, path)
	if len(rs) != 5 || rs[0].Event != "start" || rs[0].Version != "v1.2.3" || rs[4].Event != "end" || *rs[4].Exit != 0 {
		t.Fatalf("records %+v", rs)
	}
	if rs[1].Line != "linking with link.example" || rs[2].Line != "partial token=[redacted]" || rs[3].Line != "[==== ] P2" {
		t.Fatalf("lines %q %q %q", rs[1].Line, rs[2].Line, rs[3].Line)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
}

func TestJournalRefusesALooseOrLinkedFile(t *testing.T) {
	dir := t.TempDir()
	loose := filepath.Join(dir, "loose")
	_ = os.WriteFile(loose, nil, 0o644)
	if _, err := Open(loose, "up", "v", nil); err == nil {
		t.Fatal("a 0644 journal was accepted")
	}
	link := filepath.Join(dir, "link")
	_ = os.Symlink(filepath.Join(dir, "elsewhere"), link)
	if _, err := Open(link, "up", "v", nil); err == nil {
		t.Fatal("a symlinked journal was followed")
	}
}

func TestJournalRotates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	if err := os.WriteFile(path, make([]byte, MaxSize), 0o600); err != nil {
		t.Fatal(err)
	}
	j, err := Open(path, "up", "v", nil)
	if err != nil {
		t.Fatal(err)
	}
	j.Close(1)
	if st, _ := os.Stat(path + ".1"); st == nil || st.Size() != MaxSize {
		t.Fatal("the full journal was not kept as .1")
	}
	if rs := records(t, path); len(rs) != 2 {
		t.Fatalf("new journal %+v", rs)
	}
}
