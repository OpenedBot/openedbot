// Package acpbridge adapts the execution gateway contract to ACP v1 stdio.
package acpbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

var errAgentExited = errors.New("ACP agent exited")
var errWriteTimeout = errors.New("ACP stdin write timeout")
var errInvalidLines = errors.New("ACP stdout invalid-line limit exceeded")

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type rpcReply struct {
	result json.RawMessage
	err    error
}
type rpcClient struct {
	cmd          *exec.Cmd
	stdin        *os.File
	writeGate    chan struct{}
	writeTimeout time.Duration
	mu           sync.Mutex
	next         uint64
	pending      map[string]chan rpcReply
	dead         error
	done         chan struct{}
	killOnce     sync.Once
	// outboundTail is reserved only while the owning bridge mutex is held.
	outboundTail <-chan struct{}
}

func startRPC(command string, args []string, env []string, cwd string, invalidLimit int, writeTimeout time.Duration, incoming func(*rpcClient, rpcMessage)) (*rpcClient, error) {
	cmd := exec.Command(command, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Dir = cwd
	cmd.Env = env
	// Agent stderr is discarded: it may contain credentials or prompt content.
	cmd.Stderr = io.Discard
	stdinReader, stdin, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdin = stdinReader
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdinReader.Close()
		return nil, err
	}
	cmd.Stdout = stdoutWriter
	if err = cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdinReader.Close()
		_ = stdout.Close()
		_ = stdoutWriter.Close()
		return nil, err
	}
	_ = stdoutWriter.Close()
	_ = stdinReader.Close()
	c := &rpcClient{cmd: cmd, stdin: stdin, pending: map[string]chan rpcReply{}, done: make(chan struct{}), writeGate: make(chan struct{}, 1), writeTimeout: writeTimeout}
	// Own stdout independently of cmd.Wait so buffered protocol messages drain
	// after parent exit, while inherited child pipes cannot hide that exit.
	waited := make(chan struct{})
	go func() { _ = cmd.Wait(); c.kill(); close(waited) }()
	go func() {
		defer stdout.Close()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		cause := errAgentExited
		invalidCount := 0
		for scanner.Scan() {
			var m rpcMessage
			if json.Unmarshal(scanner.Bytes(), &m) != nil || m.JSONRPC != "2.0" {
				invalidCount++
				incoming(c, rpcMessage{})
				if invalidCount > invalidLimit {
					cause = errInvalidLines
					c.kill()
					break
				}
				continue
			}
			invalidCount = 0
			if m.Method != "" {
				incoming(c, m)
				continue
			}
			c.mu.Lock()
			ch := c.pending[string(m.ID)]
			delete(c.pending, string(m.ID))
			c.mu.Unlock()
			if ch != nil {
				if m.Error != nil {
					ch <- rpcReply{err: fmt.Errorf("ACP JSON-RPC error %d", m.Error.Code)}
				} else {
					ch <- rpcReply{result: m.Result}
				}
			}
		}
		c.kill()
		<-waited
		_ = stdin.Close()
		c.failPending(cause)
		close(c.done)
	}()
	return c, nil
}
func (c *rpcClient) failPending(err error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.dead == nil {
		c.dead = err
	}
	for id, ch := range c.pending {
		ch <- rpcReply{err: c.dead}
		delete(c.pending, id)
	}
	return c.dead
}
func (c *rpcClient) failWrite(err error) error {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		err = errWriteTimeout
	}
	failure := c.failPending(err)
	c.kill()
	return failure
}
func (c *rpcClient) write(ctx context.Context, m rpcMessage) error {
	ctx, cancel := context.WithTimeout(ctx, c.writeTimeout)
	defer cancel()
	select {
	case c.writeGate <- struct{}{}:
		defer func() { <-c.writeGate }()
	case <-ctx.Done():
		return c.failWrite(ctx.Err())
	}
	c.mu.Lock()
	dead := c.dead
	c.mu.Unlock()
	if dead != nil {
		return dead
	}
	if err := ctx.Err(); err != nil {
		return c.failWrite(err)
	}
	deadline, _ := ctx.Deadline()
	if err := c.stdin.SetWriteDeadline(deadline); err != nil {
		return c.failWrite(err)
	}
	if err := json.NewEncoder(c.stdin).Encode(m); err != nil {
		if ctx.Err() != nil {
			return c.failWrite(ctx.Err())
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return c.failWrite(err)
		}
		return c.failWrite(errAgentExited)
	}
	return nil
}
func (c *rpcClient) call(ctx context.Context, method string, params any, out any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if c.dead != nil {
		err = c.dead
		c.mu.Unlock()
		return err
	}
	c.next++
	id := fmt.Sprint(c.next)
	ch := make(chan rpcReply, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	if err = c.write(ctx, rpcMessage{JSONRPC: "2.0", ID: json.RawMessage(id), Method: method, Params: raw}); err != nil {
		return err
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		return json.Unmarshal(r.result, out)
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (c *rpcClient) notify(ctx context.Context, method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(ctx, rpcMessage{JSONRPC: "2.0", Method: method, Params: raw})
}
func (c *rpcClient) respond(ctx context.Context, id json.RawMessage, result any) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return c.write(ctx, rpcMessage{JSONRPC: "2.0", ID: id, Result: raw})
}
func (c *rpcClient) kill() {
	c.killOnce.Do(func() { _ = syscall.Kill(-c.cmd.Process.Pid, syscall.SIGKILL) })
}
func (c *rpcClient) stop() { c.kill(); <-c.done }
func (c *rpcClient) alive() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}
