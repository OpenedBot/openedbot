package connectorsupervisor

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func TestLinuxLifecycleKeepsTheExactInstance(t *testing.T) {
	r := exectest.NewFake().OnPrefix("/usr/bin/systemctl", exec.Result{})
	s, err := Linux(r, "dev")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Restart(ctx); err != nil {
		t.Fatal(err)
	}
	if active, err := s.Active(ctx); err != nil || !active {
		t.Fatalf("active=%t err=%v", active, err)
	}
	want := []string{
		"/usr/bin/systemctl stop hermes-connector@dev",
		"/usr/bin/systemctl daemon-reload",
		"/usr/bin/systemctl enable --now hermes-connector@dev",
		"/usr/bin/systemctl restart hermes-connector@dev",
		"/usr/bin/systemctl is-active --quiet hermes-connector@dev",
	}
	if !reflect.DeepEqual(r.Commands(), want) {
		t.Fatalf("calls=%v", r.Commands())
	}
	if s.Name() != "hermes-connector@dev.service" {
		t.Fatal(s.Name())
	}
}

func TestLinuxStopFailureIsNotSwallowed(t *testing.T) {
	r := exectest.NewFake().OnPrefix("/usr/bin/systemctl stop", exec.Result{ExitCode: 1})
	s, err := Linux(r, layout.DefaultConnectorInstance)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Stop(context.Background()); err == nil {
		t.Fatal("stop failure accepted")
	}
}

func TestInstalledRejectsServiceDefinitionSymlinks(t *testing.T) {
	r := exectest.NewFake()
	svc, err := Linux(r, "blue")
	if err != nil {
		t.Fatal(err)
	}
	s := svc.(*linuxService)
	s.unitPath = filepath.Join(t.TempDir(), "connector.service")
	if ok, err := s.Installed(); err != nil || ok {
		t.Fatalf("missing=%t err=%v", ok, err)
	}
	if err := os.WriteFile(s.unitPath, []byte("unit"), 0o600); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Installed(); err != nil || !ok {
		t.Fatalf("regular=%t err=%v", ok, err)
	}
	if err := os.Remove(s.unitPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("elsewhere.service", s.unitPath); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Installed(); err == nil || ok {
		t.Fatal("symlink accepted")
	}
	if len(r.Calls) != 0 {
		t.Fatal("installation check ran a command")
	}
}

func TestDarwinWaitingJobIsNotActive(t *testing.T) {
	r := exectest.NewFake().OnPrefix("/bin/launchctl print", exec.Result{Stdout: "state = waiting\n"})
	s, err := Darwin(testConfig(t, r))
	if err != nil {
		t.Fatal(err)
	}
	if active, err := s.Active(context.Background()); err != nil || active {
		t.Fatalf("active=%t err=%v", active, err)
	}
}

func TestDarwinRekeyRestartBootstrapsAfterBootout(t *testing.T) {
	ctx := context.Background()
	r := exectest.NewFake()
	cfg := testConfig(t, r)
	s, err := Darwin(cfg)
	if err != nil {
		t.Fatal(err)
	}
	d := s.(*darwinService)
	target := d.client.Target()
	r.On("/bin/launchctl bootout "+target, exec.Result{})
	r.On("/bin/launchctl print "+target, exec.Result{ExitCode: 113, Stderr: "Could not find service"})
	r.On("/bin/launchctl bootstrap "+d.client.Domain()+" "+d.client.PlistPath(), exec.Result{})
	r.On("/bin/launchctl kickstart "+target, exec.Result{})
	if err := s.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	// The second print observes the newly bootstrapped job.
	r.On("/bin/launchctl print "+target, exec.Result{Stdout: "state = waiting\n"})
	// Script the registration transition rather than returning one state for
	// both prints; bootstrap's confirmation must actually observe registration.
	transition := &transitionRunner{fake: r, print: "/bin/launchctl print " + target}
	cfg.Runner = transition
	d.client, err = launchd.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Restart(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(d.client.PlistPath()); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/bin/launchctl bootout " + target,
		"/bin/launchctl bootstrap " + d.client.Domain() + " " + d.client.PlistPath(),
		"/bin/launchctl print " + target,
		"/bin/launchctl kickstart " + target,
	}
	if !reflect.DeepEqual(r.Commands(), want) {
		t.Fatalf("restart calls=%v", r.Commands())
	}
	for _, c := range r.Calls {
		if c.Path != "/bin/launchctl" {
			t.Fatalf("unexpected fallback: %v", c)
		}
	}
}

type transitionRunner struct {
	fake  *exectest.Fake
	print string
	reads int
}

func (r *transitionRunner) Run(ctx context.Context, cmd exec.Cmd) (exec.Result, error) {
	if cmd.String() == r.print {
		r.reads++
		if r.reads == 1 {
			return exec.Result{ExitCode: 113, Stderr: "Could not find service"}, nil
		}
	}
	return r.fake.Run(ctx, cmd)
}

func testConfig(t *testing.T, r exec.Runner) launchd.Config {
	t.Helper()
	home := t.TempDir()
	return launchd.Config{Runner: r, LaunchctlPath: "/bin/launchctl", UID: 501, HomeDir: home,
		ExecutablePath: "/opt/ohb/edge-setup", CredentialsDirectory: filepath.Join(home, "credentials"),
		StateDirectory: filepath.Join(home, "state"), Instance: "dev"}
}
