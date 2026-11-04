// Package exec runs host commands through one Runner interface so every
// privileged action is testable with a scripted fake, and so no code path
// can shell out without leaving a record in the journal.
package exec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	osexec "os/exec"
	"strings"
	"syscall"
	"time"
)

// Cmd is one command to run. Args never carry a secret: anything secret goes
// through Stdin.
type Cmd struct {
	Path  string
	Args  []string
	Stdin []byte
	// Env, when non-nil, replaces the environment entirely.
	Env []string
	Dir string
	// Timeout bounds the command; zero means DefaultTimeout.
	Timeout time.Duration
}

// DefaultTimeout applies to commands without an explicit one.
const DefaultTimeout = 5 * time.Minute

// PipeWaitDelay bounds how long Run still waits for stdout and stderr once
// the command has exited or been killed: a descendant that left the process
// group can hold them open forever.
var PipeWaitDelay = 5 * time.Second

// Result is the outcome of a command.
type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// String renders "path args" for journals and errors.
func (c Cmd) String() string {
	return strings.TrimSpace(c.Path + " " + strings.Join(c.Args, " "))
}

// Runner executes commands.
type Runner interface {
	// Run executes the command and returns its result. A non-zero exit is
	// not an error: callers decide. An error means the command could not be
	// started or timed out.
	Run(ctx context.Context, c Cmd) (Result, error)
}

// ExitError is returned by Must when a command exits non-zero.
type ExitError struct {
	Cmd    Cmd
	Result Result
}

func (e *ExitError) Error() string {
	msg := strings.TrimSpace(e.Result.Stderr)
	if msg == "" {
		msg = strings.TrimSpace(e.Result.Stdout)
	}
	if msg == "" {
		return fmt.Sprintf("%s: exit %d", e.Cmd, e.Result.ExitCode)
	}
	return fmt.Sprintf("%s: exit %d: %s", e.Cmd, e.Result.ExitCode, msg)
}

// Must runs c and fails on a non-zero exit.
func Must(ctx context.Context, r Runner, c Cmd) (Result, error) {
	res, err := r.Run(ctx, c)
	if err != nil {
		return res, err
	}
	if res.ExitCode != 0 {
		return res, &ExitError{Cmd: c, Result: res}
	}
	return res, nil
}

// Output runs c, requires exit 0 and returns trimmed stdout.
func Output(ctx context.Context, r Runner, path string, args ...string) (string, error) {
	res, err := Must(ctx, r, Cmd{Path: path, Args: args})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(res.Stdout), nil
}

// Host runs commands on the real host.
type Host struct{}

// Run implements Runner.
func (Host) Run(ctx context.Context, c Cmd) (Result, error) {
	timeout := c.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := osexec.CommandContext(ctx, c.Path, c.Args...)
	// The command leads its own process group and a timeout kills the whole
	// group: killing only the command left its children running, holding the
	// output pipes, and Run waiting on them well past the timeout.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		return nil
	}
	cmd.WaitDelay = PipeWaitDelay
	if c.Env != nil {
		cmd.Env = c.Env
	}
	cmd.Dir = c.Dir
	if c.Stdin != nil {
		cmd.Stdin = bytes.NewReader(c.Stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	res := Result{Stdout: out.String(), Stderr: errb.String()}
	if err == nil {
		return res, nil
	}
	if errors.Is(err, osexec.ErrWaitDelay) && ctx.Err() == nil {
		// The command succeeded; a process it left behind still held its
		// output, which was closed after PipeWaitDelay.
		return res, nil
	}
	var exit *osexec.ExitError
	if errors.As(err, &exit) {
		res.ExitCode = exit.ExitCode()
		if ctx.Err() != nil {
			return res, fmt.Errorf("%s: %w", c, ctx.Err())
		}
		return res, nil
	}
	return res, fmt.Errorf("%s: %w", c, err)
}
