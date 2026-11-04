package exec

import (
	"context"
	osexec "os/exec"
	"strings"
	"testing"
	"time"
)

// A timeout bounds the command and everything it started: a child that
// inherits stdout used to keep Run waiting until the child itself exited.
func TestHostTimeoutBoundsChildrenHoldingThePipes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		script string
	}{
		{"child in the background", "sleep 5 & sleep 5"},
		{"child in the foreground", "sleep 5; echo never"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			start := time.Now()
			_, err := Host{}.Run(context.Background(), Cmd{Path: "/bin/sh", Args: []string{"-c", tc.script}, Timeout: 100 * time.Millisecond})
			if err == nil || !strings.Contains(err.Error(), "deadline exceeded") {
				t.Fatalf("err = %v, want the timeout", err)
			}
			if elapsed := time.Since(start); elapsed > 2*time.Second {
				t.Fatalf("returned after %v, want about the timeout", elapsed)
			}
		})
	}
}

// A command that succeeds but leaves a process outside its group holding its
// output is still a success, reported once PipeWaitDelay has passed.
func TestHostSuccessWithAnEscapedChildReturnsAfterPipeWaitDelay(t *testing.T) {
	if _, err := osexec.LookPath("perl"); err != nil {
		t.Skip("perl is needed to leave the process group")
	}
	prev := PipeWaitDelay
	PipeWaitDelay = 100 * time.Millisecond
	t.Cleanup(func() { PipeWaitDelay = prev })
	start := time.Now()
	// perl's setpgrp moves the child out of the command's process group.
	res, err := Host{}.Run(context.Background(), Cmd{Path: "/bin/sh", Args: []string{"-c", `echo ok; perl -e 'setpgrp(0,0); sleep 3' &`}, Timeout: 10 * time.Second})
	if err != nil || res.ExitCode != 0 || strings.TrimSpace(res.Stdout) != "ok" {
		t.Fatalf("res %+v err %v", res, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("returned after %v", elapsed)
	}
}

func TestHostReportsExitCodes(t *testing.T) {
	res, err := Host{}.Run(context.Background(), Cmd{Path: "/bin/sh", Args: []string{"-c", "echo out; echo err >&2; exit 3"}})
	if err != nil || res.ExitCode != 3 || res.Stdout != "out\n" || res.Stderr != "err\n" {
		t.Fatalf("res %+v err %v", res, err)
	}
}
