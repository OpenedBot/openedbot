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
)

var errAgentExited = errors.New("ACP agent exited")
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
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	writeMu  sync.Mutex
	mu       sync.Mutex
	next     uint64
	pending  map[string]chan rpcReply
	dead     error
	done     chan struct{}
	killOnce sync.Once
}

func startRPC(command string, args []string, env []string, cwd string, invalidLimit int, incoming func(*rpcClient, rpcMessage)) (*rpcClient, error) {
	cmd := exec.Command(command, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Dir = cwd
	cmd.Env = env
	// Agent stderr is discarded: it may contain credentials or prompt content.
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	cmd.Stdout = stdoutWriter
	if err = cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stdoutWriter.Close()
		return nil, err
	}
	_ = stdoutWriter.Close()
	c := &rpcClient{cmd: cmd, stdin: stdin, pending: map[string]chan rpcReply{}, done: make(chan struct{})}
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
		c.mu.Lock()
		c.dead = cause
		for id, ch := range c.pending {
			ch <- rpcReply{err: cause}
			delete(c.pending, id)
		}
		c.mu.Unlock()
		close(c.done)
	}()
	return c, nil
}
func (c *rpcClient) write(m rpcMessage) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return json.NewEncoder(c.stdin).Encode(m)
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
	if err = c.write(rpcMessage{JSONRPC: "2.0", ID: json.RawMessage(id), Method: method, Params: raw}); err != nil {
		return errAgentExited
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
func (c *rpcClient) notify(method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(rpcMessage{JSONRPC: "2.0", Method: method, Params: raw})
}
func (c *rpcClient) respond(id json.RawMessage, result any) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return c.write(rpcMessage{JSONRPC: "2.0", ID: id, Result: raw})
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
