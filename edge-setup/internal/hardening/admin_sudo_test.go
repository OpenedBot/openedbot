package hardening

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

const hardenedSSHD = "allowusers hermes-admin\npermitrootlogin no\npasswordauthentication no\nkbdinteractiveauthentication no\nauthenticationmethods publickey\n"

const sshdForAdmin = "/usr/sbin/sshd -T -C user=hermes-admin,host=localhost,addr=127.0.0.1"

func TestAdminSudoModes(t *testing.T) {
	for _, c := range []struct {
		o        Options
		noPasswd bool
		err      string
	}{
		{Options{AdminPassword: "correct-horse-battery"}, false, ""},
		{Options{AdminSudo: layout.AdminSudoPassword, AdminPassword: "correct-horse-battery"}, false, ""},
		{Options{AdminSudo: layout.AdminSudoNoPasswd}, true, ""},
		{Options{}, false, "14 to 256"},
		{Options{AdminSudo: layout.AdminSudoPassword, AdminPassword: "short"}, false, "14 to 256"},
		{Options{AdminSudo: "maybe", AdminPassword: "correct-horse-battery"}, false, "--admin-sudo must be"},
	} {
		got, err := adminNoPasswd(c.o)
		if c.err == "" && (err != nil || got != c.noPasswd) {
			t.Errorf("%q: = %v, %v; want %v", c.o.AdminSudo, got, err, c.noPasswd)
		}
		if c.err != "" && (err == nil || !strings.Contains(err.Error(), c.err)) {
			t.Errorf("%q: err = %v, want %q", c.o.AdminSudo, err, c.err)
		}
	}
}

func TestValidAdminPassword(t *testing.T) {
	for p, ok := range map[string]bool{
		"correct-horse-battery":   true,
		"élan vital à 14 lettres": true,
		"13-chars-xxxx":           false,
		"14-chars-xxxxx":          true,
		"has\nnewline-in-it":      false,
		"has\ttab-in-it-here":     false,
		strings.Repeat("a", 257):  false,
		"\xff\xfe-not-utf8-text":  false,
	} {
		if err := ValidAdminPassword(p); (err == nil) != ok {
			t.Errorf("%q: err = %v, want ok=%v", p, err, ok)
		}
		if err := ValidAdminPassword(p); err != nil && strings.Contains(err.Error(), p) {
			t.Errorf("the refusal quotes the password: %v", err)
		}
	}
}

// A password mode without a usable password is refused before Prepare runs a
// single command or takes a single snapshot.
func TestPrepareRefusesAPasswordModeWithoutAPasswordBeforeAnyChange(t *testing.T) {
	h, fake := guardedHost(t, "")
	_, err := h.Prepare(context.Background(), Options{Features: state.Features{SSHHardening: true}, Guarded: true, AdminPublicKey: "ssh-ed25519 AAAA test"})
	if err == nil || !strings.Contains(err.Error(), "sudo password") {
		t.Fatalf("Prepare = %v", err)
	}
	if len(fake.Calls) != 0 || len(h.Guard.Artifacts()) != 0 {
		t.Errorf("ran %v, left %v", fake.Commands(), h.Guard.Artifacts())
	}
}

func recordRun(fake *exectest.Fake) func(exec.Cmd) error {
	return func(c exec.Cmd) error {
		_, err := exec.Must(context.Background(), fake, c)
		return err
	}
}

// The password goes to chpasswd on stdin only, after the effective sshd
// policy for hermes-admin refuses passwords.
func TestSetAdminPasswordGoesThroughStdinAfterSSHDRefusesPasswords(t *testing.T) {
	fake := exectest.NewFake()
	fake.On(sshdForAdmin, exec.Result{Stdout: hardenedSSHD})
	fake.On("/usr/sbin/chpasswd", exec.Result{})
	h := &Hardener{Runner: fake}
	const pw = "correct-horse-battery"
	if err := h.setAdminPassword(context.Background(), recordRun(fake), pw); err != nil {
		t.Fatal(err)
	}
	if got := fake.Commands(); len(got) != 2 || got[0] != sshdForAdmin || got[1] != "/usr/sbin/chpasswd" {
		t.Fatalf("ran %v", got)
	}
	if string(fake.Calls[1].Stdin) != "hermes-admin:"+pw+"\n" {
		t.Errorf("chpasswd stdin = %q", fake.Calls[1].Stdin)
	}
	for _, c := range fake.Calls {
		if strings.Contains(c.String(), pw) {
			t.Errorf("the password reached an argument: %s", c)
		}
	}
}

func TestSetAdminPasswordRefusedWhileSSHDMayAcceptPasswords(t *testing.T) {
	fake := exectest.NewFake()
	fake.On(sshdForAdmin, exec.Result{Stdout: strings.Replace(hardenedSSHD, "passwordauthentication no", "passwordauthentication yes", 1)})
	h := &Hardener{Runner: fake}
	err := h.setAdminPassword(context.Background(), recordRun(fake), "correct-horse-battery")
	if err == nil || !strings.Contains(err.Error(), "while sshd may accept it") {
		t.Fatalf("err = %v", err)
	}
	if fake.Ran("/usr/sbin/chpasswd") {
		t.Error("chpasswd ran while sshd accepts passwords")
	}
}

func TestSetAdminPasswordNeverReturnsThePassword(t *testing.T) {
	const pw = "correct-horse-battery"
	fake := exectest.NewFake()
	fake.On(sshdForAdmin, exec.Result{Stdout: hardenedSSHD})
	h := &Hardener{Runner: fake}
	echo := func(exec.Cmd) error {
		return errors.New("chpasswd: (line 1, user hermes-admin) " + pw + " rejected: BAD PASSWORD")
	}
	err := h.setAdminPassword(context.Background(), echo, pw)
	if err == nil || strings.Contains(err.Error(), pw) || !strings.Contains(err.Error(), "[redacted]") {
		t.Fatalf("err = %v", err)
	}
}
