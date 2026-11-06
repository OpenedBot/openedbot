// Package connectorsupervisor manages exactly one connector instance through
// the host's service manager. Gateway and operator services are outside it.
package connectorsupervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Service is the lifecycle shared by systemd and per-user LaunchAgents.
// Installed does not claim that a registered job has a running process.
type Service interface {
	Name() string
	Installed() (bool, error)
	Stop(context.Context) error
	Start(context.Context) error
	Restart(context.Context) error
	Active(context.Context) (bool, error)
}

// Linux configures the existing connector units. Paths and unit names keep
// their established contract with already provisioned Linux hosts.
func Linux(r exec.Runner, inst layout.ConnectorInstance) (Service, error) {
	if r == nil {
		return nil, errors.New("connector supervisor runner is required")
	}
	parsed, err := layout.ParseConnectorInstance(string(inst))
	if err != nil {
		return nil, errors.New("invalid connector instance")
	}
	unit := layout.ConnectorUnit
	if !parsed.IsDefault() {
		unit = layout.ConnectorTemplateUnit
	}
	return &linuxService{
		sd: systemd.Client{Runner: r}, instance: parsed,
		unitPath: filepath.Join("/etc/systemd/system", unit+".service"),
	}, nil
}

type linuxService struct {
	sd       systemd.Client
	instance layout.ConnectorInstance
	unitPath string
}

func (s *linuxService) Name() string                   { return s.instance.Unit() + ".service" }
func (s *linuxService) Installed() (bool, error)       { return regularFile(s.unitPath) }
func (s *linuxService) Stop(ctx context.Context) error { return s.sd.Stop(ctx, s.instance.Unit()) }
func (s *linuxService) Start(ctx context.Context) error {
	if err := s.sd.DaemonReload(ctx); err != nil {
		return err
	}
	return s.sd.EnableNow(ctx, s.instance.Unit())
}
func (s *linuxService) Restart(ctx context.Context) error {
	return s.sd.Restart(ctx, s.instance.Unit())
}
func (s *linuxService) Active(ctx context.Context) (bool, error) {
	return s.sd.IsActive(ctx, s.instance.Unit())
}

// Darwin receives user-owned paths from the macOS installer. It never falls
// back to systemd or another user's launchd domain if a LaunchAgent fails.
func Darwin(cfg launchd.Config) (Service, error) {
	c, err := launchd.New(cfg)
	if err != nil {
		return nil, err
	}
	return &darwinService{client: c}, nil
}

type darwinService struct{ client *launchd.Client }

func (s *darwinService) Name() string                    { return s.client.Label() }
func (s *darwinService) Installed() (bool, error)        { return regularFile(s.client.PlistPath()) }
func (s *darwinService) Stop(ctx context.Context) error  { return s.client.Stop(ctx) }
func (s *darwinService) Start(ctx context.Context) error { return s.client.Start(ctx) }
func (s *darwinService) Restart(ctx context.Context) error {
	status, err := s.client.Status(ctx)
	if err != nil {
		return err
	}
	// Unlike systemctl stop, bootout unregisters the LaunchAgent. A command
	// that stops the connector before rewriting its state must therefore
	// bootstrap the job again.
	if !status.Registered {
		return s.client.Start(ctx)
	}
	return s.client.Restart(ctx)
}
func (s *darwinService) Active(ctx context.Context) (bool, error) {
	status, err := s.client.Status(ctx)
	return status.Running, err
}

func regularFile(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("connector service definition is not a regular file")
	}
	return true, nil
}
