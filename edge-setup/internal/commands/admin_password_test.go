package commands

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func fakeTTY(lines string, hidden ...string) (*adminTTY, *bytes.Buffer) {
	out := &bytes.Buffer{}
	i := 0
	return &adminTTY{r: bufio.NewReader(strings.NewReader(lines)), w: out, readHide: func() (string, error) {
		if i >= len(hidden) {
			return "", errors.New("no more input")
		}
		i++
		return hidden[i-1], nil
	}}, out
}

var generatedRe = regexp.MustCompile(`^[A-HJ-NP-Za-km-z2-9]{5}(-[A-HJ-NP-Za-km-z2-9]{5}){4}$`)

func TestGeneratedAdminPasswordsAreReadableAndDistinct(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		p, err := generateAdminPassword(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		if !generatedRe.MatchString(p) {
			t.Fatalf("%q", p)
		}
		if seen[p] {
			t.Fatal("a generated password repeated")
		}
		seen[p] = true
	}
}

func TestAskAdminPasswordTypedTwice(t *testing.T) {
	tty, out := fakeTTY("", "correct-horse-battery", "correct-horse-battery")
	p, err := askAdminPassword(tty, rand.Reader)
	if err != nil || p != "correct-horse-battery" {
		t.Fatalf("= %q, %v", p, err)
	}
	if strings.Contains(out.String(), p) {
		t.Error("a typed password was echoed")
	}
	for _, c := range []struct {
		hidden []string
		want   string
	}{
		{[]string{"correct-horse-battery", "correct-horse-batterY"}, "differ"},
		{[]string{"short"}, "14 to 256"},
	} {
		tty, _ := fakeTTY("", c.hidden...)
		if _, err := askAdminPassword(tty, rand.Reader); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: err = %v, want %q", c.hidden, err, c.want)
		}
	}
}

// An empty answer generates a password, shows it once on the terminal, and
// goes on only once the operator says it is stored.
func TestAskAdminPasswordGeneratedIsShownOnceAndConfirmed(t *testing.T) {
	tty, out := fakeTTY("stored\n", "")
	p, err := askAdminPassword(tty, rand.Reader)
	if err != nil || !generatedRe.MatchString(p) {
		t.Fatalf("= %q, %v", p, err)
	}
	if n := strings.Count(out.String(), p); n != 1 {
		t.Errorf("the generated password was shown %d times", n)
	}
	tty, _ = fakeTTY("yes\n", "")
	if _, err := askAdminPassword(tty, rand.Reader); err == nil || !strings.Contains(err.Error(), "not confirmed") {
		t.Errorf("err = %v", err)
	}
}

func TestAdminSudoPasswordWithoutATerminalNamesTheWaysOut(t *testing.T) {
	_, err := adminSudoPassword("", func() (*adminTTY, func(), error) { return nil, nil, errors.New("no tty") })
	if err == nil || !strings.Contains(err.Error(), "--admin-password-file") || !strings.Contains(err.Error(), "--admin-sudo=nopasswd") {
		t.Fatalf("err = %v", err)
	}
}

func TestAdminPasswordFile(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good")
	if err := os.WriteFile(good, []byte("correct-horse-battery\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if p, err := adminSudoPassword(good, nil); err != nil || p != "correct-horse-battery" {
		t.Fatalf("= %q, %v", p, err)
	}
	open := filepath.Join(dir, "open")
	if err := os.WriteFile(open, []byte("correct-horse-battery\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := adminSudoPassword(open, nil); err == nil || !strings.Contains(err.Error(), "0600") {
		t.Errorf("a 0644 file: err = %v", err)
	}
	short := filepath.Join(dir, "short")
	if err := os.WriteFile(short, []byte("short\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := adminSudoPassword(short, nil); err == nil || strings.Contains(err.Error(), "short") {
		t.Errorf("a short password: err = %v", err)
	}
}
