package sandbox

import (
	"context"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

func pulled(f *exectest.Fake) bool {
	for _, c := range f.Commands() {
		if strings.Contains(c, "docker pull") {
			return true
		}
	}
	return false
}

func TestEnsureImageSkipsPullWhenDigestPresent(t *testing.T) {
	f := exectest.NewFake()
	f.Default = &exec.Result{ExitCode: 0, Stdout: "sha256:present\n"}
	if err := ensureImage(context.Background(), f, 999); err != nil {
		t.Fatal(err)
	}
	if pulled(f) {
		t.Fatalf("pulled although the pinned digest is present: %v", f.Commands())
	}
}

func TestEnsureImagePullsWhenDigestMissing(t *testing.T) {
	f := exectest.NewFake()
	inspectFails := exec.Result{ExitCode: 1, Stderr: "No such image"}
	f.Default = &exec.Result{ExitCode: 0}
	inspect := ""
	if err := ensureImage(context.Background(), recorder{f: f, inspect: &inspect, fail: inspectFails}, 999); err != nil {
		t.Fatal(err)
	}
	if !pulled(f) {
		t.Fatalf("did not pull a missing image: %v", f.Commands())
	}
}

// recorder fails the inspect call and delegates everything else to the fake.
type recorder struct {
	f       *exectest.Fake
	inspect *string
	fail    exec.Result
}

func (r recorder) Run(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	if strings.Contains(c.String(), "docker image inspect") {
		*r.inspect = c.String()
		_, _ = r.f.Run(ctx, c)
		return r.fail, nil
	}
	return r.f.Run(ctx, c)
}
