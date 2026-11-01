package operator

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeGatewayUnit struct {
	pids     []string // MainPID answers, in order; the last one repeats
	state    string
	signals  []string
	restarts int
	reads    int
}

func (f *fakeGatewayUnit) Show(_ context.Context, _ string, property string) (string, error) {
	if property == "ActiveState" {
		return f.state, nil
	}
	pid := f.pids[min(f.reads, len(f.pids)-1)]
	f.reads++
	return pid + "\n", nil
}

func (f *fakeGatewayUnit) Signal(_ context.Context, _ string, signal string) error {
	f.signals = append(f.signals, signal)
	return nil
}

func (f *fakeGatewayUnit) Restart(context.Context, ...string) error {
	f.restarts++
	return nil
}

func TestGracefulRestartSignalsAndWaitsForTheNewProcess(t *testing.T) {
	// Draining (same PID), exited and relaunching (0), then the new process.
	unit := &fakeGatewayUnit{pids: []string{"100", "100", "100", "0", "200"}, state: "activating"}
	if err := gracefulGatewayRestart(context.Background(), unit, time.Millisecond); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if len(unit.signals) != 1 || unit.signals[0] != "SIGUSR1" {
		t.Fatalf("signals = %v, want one SIGUSR1", unit.signals)
	}
	if unit.restarts != 0 {
		t.Fatalf("a draining gateway must never get systemctl restart (SIGTERM cuts its runs)")
	}
}

func TestGracefulRestartOfAStoppedGatewayIsAPlainRestart(t *testing.T) {
	unit := &fakeGatewayUnit{pids: []string{"0"}}
	if err := gracefulGatewayRestart(context.Background(), unit, time.Millisecond); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if unit.restarts != 1 || len(unit.signals) != 0 {
		t.Fatalf("restarts=%d signals=%v, want a plain restart", unit.restarts, unit.signals)
	}
}

func TestGracefulRestartReportsAGatewaySystemdDidNotRelaunch(t *testing.T) {
	unit := &fakeGatewayUnit{pids: []string{"100", "0"}, state: "failed"}
	err := gracefulGatewayRestart(context.Background(), unit, time.Millisecond)
	if err == nil {
		t.Fatal("a failed unit must end the restart with an error")
	}
}

func TestGracefulRestartIsBoundedByItsContext(t *testing.T) {
	unit := &fakeGatewayUnit{pids: []string{"100"}, state: "active"}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := gracefulGatewayRestart(ctx, unit, time.Millisecond)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the deadline", err)
	}
}
