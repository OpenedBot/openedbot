package hardening

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const auditedCloudKey = "SHA256:" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"

// RestoreCloudUser works with no transaction at all (the state reset is in)
// and only reports success once the account carries its audited access again.
func TestRestoreCloudUserRestoresThenProvesTheAuditedAccess(t *testing.T) {
	cases := []struct {
		name    string
		shell   string
		keygen  string
		groups  string
		wantErr string
	}{
		{"restored", "/bin/bash", "256 " + auditedCloudKey + " debian (ED25519)", "debian sudo", ""},
		{"shell not restored", "/usr/sbin/nologin", "256 " + auditedCloudKey + " debian (ED25519)", "debian sudo", "shell"},
		{"another key", "/bin/bash", "256 SHA256:" + strings.Repeat("Z", 43) + " x (ED25519)", "debian sudo", "audited key"},
		{"sudo not restored", "/bin/bash", "256 " + auditedCloudKey + " debian (ED25519)", "debian", "sudo membership"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			prevRoot := fsx.Root
			fsx.Root = fsx.Current()
			t.Cleanup(func() { fsx.Root = prevRoot })
			root := t.TempDir()
			f := exectest.NewFake()
			f.Default = &exec.Result{}
			q := layout.QuarantineUser
			f.On("/usr/bin/getent passwd "+q, exec.Result{Stdout: q + ":x:1000:1000::/home/" + q + ":" + tc.shell})
			f.On("/usr/bin/id -nG "+q, exec.Result{Stdout: tc.groups})
			home := filepath.Join(root, "home")
			if err := os.MkdirAll(home, 0o755); err != nil {
				t.Fatal(err)
			}
			f.On("/usr/bin/ssh-keygen -lf "+home+"/.ssh/authorized_keys -E sha256", exec.Result{Stdout: tc.keygen})
			cur := fsx.Current()
			lookup := func(name string) (*user.User, error) {
				if name == q {
					return &user.User{Uid: strconv.Itoa(cur.UID), Gid: strconv.Itoa(cur.GID), Username: q, HomeDir: home}, nil
				}
				return nil, user.UnknownUserError(name)
			}
			g := guard.New(filepath.Join(root, "state"), filepath.Join(root, "backup"), layout.HardeningRollbackUnit, cur, f)
			if err := g.EnsureDirs(); err != nil {
				t.Fatal(err)
			}
			writeBackup(t, g, "debian.authorized_keys", "ssh-ed25519 AAAA debian\n")
			writeBackup(t, g, "debian.sudoers", layout.QuarantineSudoersLine+"\n")
			manifest := "user=debian\nshell=/bin/bash\ngroups=debian sudo\npassword_status=debian L\nkey_fingerprint=" + auditedCloudKey + "\n"
			if err := fsx.WriteAtomic(g.BackupPath("debian.manifest"), []byte(manifest), 0o600, cur); err != nil {
				t.Fatal(err)
			}
			h := New(f, nil)
			h.Guard, h.Accounts = g, account.Client{Runner: f, Lookup: lookup}
			h.QuarantineHome, h.QuarantineSudoers = home, filepath.Join(root, "90-cloud-init-users")

			err := h.RestoreCloudUser(context.Background())
			if tc.wantErr == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want one about %q", err, tc.wantErr)
			}
			if got, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys")); string(got) != "ssh-ed25519 AAAA debian\n" {
				t.Errorf("authorized_keys = %q", got)
			}
			if !f.Ran("/usr/sbin/usermod --lock --shell /bin/bash " + q) {
				t.Errorf("shell not restored; commands: %v", f.Commands())
			}
			if !f.Ran("/usr/sbin/visudo -cf /etc/sudoers") || !f.Ran("/usr/sbin/sshd -t") {
				t.Errorf("sudoers and sshd not validated; commands: %v", f.Commands())
			}
		})
	}
}

func TestRestoreCloudUserRefusesMissingBackups(t *testing.T) {
	root := t.TempDir()
	f := exectest.NewFake()
	f.Default = &exec.Result{}
	g := guard.New(filepath.Join(root, "state"), filepath.Join(root, "backup"), layout.HardeningRollbackUnit, fsx.Current(), f)
	if err := g.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	writeBackup(t, g, "debian.manifest", "user=debian\n")
	h := New(f, nil)
	h.Guard = g
	if err := h.RestoreCloudUser(context.Background()); err == nil || !strings.Contains(err.Error(), "debian.authorized_keys") {
		t.Fatalf("err = %v", err)
	}
	if len(f.Commands()) != 0 {
		t.Fatalf("something ran without backups: %v", f.Commands())
	}
}

func writeBackup(t *testing.T, g *guard.Guard, name, content string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(src, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := g.Backup(src, name); err != nil {
		t.Fatal(err)
	}
}
