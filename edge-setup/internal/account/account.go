// Package account manages the local accounts the tool creates: the single
// runtime/connector service user and, optionally, the SSH administrator.
package account

import (
	"context"
	"fmt"
	"os/user"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

// Client manages accounts through the runner.
type Client struct {
	Runner exec.Runner
	// Lookup resolves a user; defaults to os/user.
	Lookup func(name string) (*user.User, error)
}

// New returns a client.
func New(r exec.Runner) Client { return Client{Runner: r, Lookup: user.Lookup} }

// Info is what the tool needs to know about an account.
type Info struct {
	Name  string
	UID   int
	GID   int
	Home  string
	Shell string
}

// Get returns the account or nil if absent.
func (c Client) Get(ctx context.Context, name string) (*Info, error) {
	u, err := c.Lookup(name)
	if err != nil {
		if _, ok := err.(user.UnknownUserError); ok {
			return nil, nil
		}
		return nil, err
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	shell, err := c.shell(ctx, name)
	if err != nil {
		return nil, err
	}
	return &Info{Name: name, UID: uid, GID: gid, Home: u.HomeDir, Shell: shell}, nil
}

func (c Client) shell(ctx context.Context, name string) (string, error) {
	out, err := exec.Output(ctx, c.Runner, "/usr/bin/getent", "passwd", name)
	if err != nil {
		return "", err
	}
	f := strings.Split(out, ":")
	if len(f) < 7 {
		return "", fmt.Errorf("getent passwd %s: unexpected %q", name, out)
	}
	return f[6], nil
}

// EnsureSystemUser creates a locked system account with nologin if absent.
func (c Client) EnsureSystemUser(ctx context.Context, name, home string) (*Info, error) {
	if info, err := c.Get(ctx, name); err != nil || info != nil {
		return info, err
	}
	_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: "/usr/sbin/useradd", Args: []string{
		"--system", "--user-group", "--shell", "/usr/sbin/nologin", "--home-dir", home, "--create-home", name,
	}})
	if err != nil {
		return nil, err
	}
	return c.Get(ctx, name)
}

// EnsureLoginUser creates a regular account with a locked password (key
// only) and a bash shell, if absent.
func (c Client) EnsureLoginUser(ctx context.Context, name string) (*Info, error) {
	if info, err := c.Get(ctx, name); err != nil || info != nil {
		return info, err
	}
	_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: "/usr/sbin/useradd", Args: []string{
		"--user-group", "--shell", "/bin/bash", "--home-dir", "/home/" + name, "--create-home", name,
	}})
	if err != nil {
		return nil, err
	}
	if _, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: "/usr/sbin/usermod", Args: []string{"--lock", name}}); err != nil {
		return nil, err
	}
	return c.Get(ctx, name)
}

// Groups returns the supplementary groups of an account.
func (c Client) Groups(ctx context.Context, name string) ([]string, error) {
	out, err := exec.Output(ctx, c.Runner, "/usr/bin/id", "-nG", name)
	if err != nil {
		return nil, err
	}
	return strings.Fields(out), nil
}

// InGroup reports membership.
func InGroup(groups []string, g string) bool {
	for _, x := range groups {
		if x == g {
			return true
		}
	}
	return false
}

// RequireUnprivileged fails if the account is in sudo or docker.
func (c Client) RequireUnprivileged(ctx context.Context, name string) error {
	groups, err := c.Groups(ctx, name)
	if err != nil {
		return err
	}
	for _, g := range []string{"sudo", "docker"} {
		if InGroup(groups, g) {
			return fmt.Errorf("%s is in group %s; a runtime executing tools for a model must not be able to escalate", name, g)
		}
	}
	return nil
}

// Delete removes an account and its home.
func (c Client) Delete(ctx context.Context, name string) error {
	_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: "/usr/sbin/userdel", Args: []string{"--force", "--remove", name}})
	return err
}

// AsUser returns a command prefix running as name through runuser with a
// minimal environment. Secrets pass through Stdin, never Env.
func AsUser(name string, env []string, path string, args ...string) exec.Cmd {
	a := []string{"-u", name, "--", "/usr/bin/env"}
	a = append(a, env...)
	a = append(a, path)
	a = append(a, args...)
	return exec.Cmd{Path: "/usr/sbin/runuser", Args: a}
}
