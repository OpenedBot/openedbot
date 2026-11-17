// Package acphost provisions the experimental Linux OpenCode engine.
package acphost

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/download"
	"github.com/OpenedBot/openedbot/edge-setup/internal/egress"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/render"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Paths permits installation proofs in a temporary filesystem.
type Paths struct{ Runtime, Agent, Profiles, State, Config, Credentials, Downloads, Unit string }

func HostPaths() Paths {
	return Paths{layout.RuntimeRoot, layout.ACPAgentDir, layout.ACPProfilesRoot, layout.ACPBridgeState, layout.ACPConfigDir, layout.ACPCredentials, layout.DownloadDir, layout.ACPBridgeUnitPath}
}

// PermissionConfig is loaded from a root-owned directory, including HOME and
// inline configuration layer. Project configuration is disabled.
const PermissionConfig = "{\n  \"permission\": \"ask\",\n  \"autoupdate\": false,\n  \"share\": \"disabled\"\n}\n"

type Installer struct {
	Runner   exec.Runner
	Apt      apt.Client
	Accounts account.Client
	Download download.Client
	Paths    Paths
	Owner    fsx.Owner
	Arch     string
	Log      func(string, ...any)
}

func New(r exec.Runner, arch string, log func(string, ...any)) *Installer {
	return &Installer{Runner: r, Apt: apt.New(r), Accounts: account.New(r), Download: download.Default(), Paths: HostPaths(), Owner: fsx.Root, Arch: arch, Log: log}
}

// Run keeps the gateway bearer on replay, and replaces the agent only after
// its official archive digest is verified. force restarts a bridge whose
// executable (edge-setup itself) changed during upgrade.
func (i *Installer) Run(ctx context.Context, force bool) error {
	release, ok := pins.OpenCodeArches[i.Arch]
	if !ok {
		return errors.New("unsupported OpenCode Linux architecture")
	}
	if err := i.Apt.Install(ctx, pins.OpenCodeSystemPackages...); err != nil {
		return err
	}
	p := i.Paths
	info, err := i.Accounts.EnsureSystemUser(ctx, layout.ServiceUser, "/home/"+layout.ServiceUser)
	if err != nil {
		return err
	}
	if info == nil {
		return errors.New("service account missing after creation")
	}
	if err := i.Accounts.RequireUnprivileged(ctx, layout.ServiceUser); err != nil {
		return err
	}
	for _, dir := range []string{p.Runtime, p.Agent, p.Config, filepath.Join(p.Config, "home")} {
		if err := fsx.EnsureDir(dir, 0o755, i.Owner); err != nil {
			return err
		}
	}
	for _, dir := range []string{p.State, p.Downloads} {
		if err := fsx.EnsureDir(dir, 0o700, i.Owner); err != nil {
			return err
		}
	}
	userOwner := fsx.Owner{UID: info.UID, GID: info.GID}
	for _, dir := range []string{p.Profiles, filepath.Join(p.Runtime, "acp-home")} {
		if err := fsx.EnsureDir(dir, 0o700, userOwner); err != nil {
			return err
		}
	}
	changed, err := hermes.EnsureRuntimeEnv(filepath.Join(p.Runtime, "runtime.env"), i.Owner, i.Log)
	if err != nil {
		return err
	}
	configChanged, err := writeChanged(filepath.Join(p.Config, "opencode.json"), PermissionConfig, 0o644, i.Owner)
	if err != nil {
		return err
	}
	stamp := filepath.Join(p.Agent, "version")
	version, _ := os.ReadFile(stamp)
	if string(version) != pins.OpenCodeVersion || !fsx.Exists(filepath.Join(p.Agent, "opencode")) {
		archive := filepath.Join(p.Downloads, "opencode-"+pins.OpenCodeVersion+"-"+release.Target+".tar.gz")
		if err := i.Download.Fetch(ctx, pins.OpenCodeArchiveURL(release), archive, download.SHA256, release.SHA256, 0o600, i.Owner); err != nil {
			return err
		}
		if err := i.extract(archive); err != nil {
			return err
		}
		spec := agentCommand(p, "--version")
		spec.Timeout = 30 * time.Second
		result, err := exec.Must(ctx, i.Runner, spec)
		if err != nil {
			return err
		}
		if result.Stdout != pins.OpenCodeVersion+"\n" {
			return errors.New("installed OpenCode version does not match its pin")
		}
		if err := fsx.WriteAtomic(stamp, []byte(pins.OpenCodeVersion), 0o644, i.Owner); err != nil {
			return err
		}
		changed = true
	}
	unit, err := render.ACPBridgeUnit(egress.ResolverAllowFrom(layout.ResolvConf, "ACP bridge", i.Log))
	if err != nil {
		return err
	}
	unitChanged, err := writeChanged(p.Unit, unit, 0o644, i.Owner)
	if err != nil {
		return err
	}
	sd := systemd.Client{Runner: i.Runner}
	if err := sd.DaemonReload(ctx); err != nil {
		return err
	}
	if err := sd.EnableNow(ctx, layout.ACPBridgeUnit); err != nil {
		return err
	}
	if force || changed || configChanged || unitChanged {
		return sd.Restart(ctx, layout.ACPBridgeUnit)
	}
	return nil
}

func writeChanged(path, content string, mode os.FileMode, owner fsx.Owner) (bool, error) {
	data, err := fsx.ReadRegular(path, mode, owner)
	if err == nil && string(data) == content {
		return false, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return true, fsx.WriteAtomic(path, []byte(content), mode, owner)
}

func (i *Installer) extract(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gz.Close()
	archive := tar.NewReader(gz)
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return errors.New("OpenCode archive has no opencode binary")
		}
		if err != nil {
			return err
		}
		if header.Name != "opencode" && header.Name != "./opencode" {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size > 512<<20 {
			return fmt.Errorf("invalid OpenCode archive entry")
		}
		data, err := io.ReadAll(archive)
		if err != nil {
			return err
		}
		return fsx.WriteAtomic(filepath.Join(i.Paths.Agent, "opencode"), data, 0o755, i.Owner)
	}
}
