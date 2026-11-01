package commands

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

// retireTimeout bounds the revocation session of one instance: an openedbot
// older than link.retire never answers it.
var retireTimeout = 20 * time.Second

// retireSession runs the revocation session; tests replace it.
var retireSession = func(ctx context.Context, c *connector.Client) error { return c.Retire(ctx) }

// retireDeviceKey reads the existing device key; tests replace it.
var retireDeviceKey = existingDeviceKey

// retireManualHint is where an operator revokes a runtime the host could not.
const retireManualHint = "revoke it in openedbot: Settings → Installation → Edge"

// retireLink asks openedbot to revoke the runtime of inst over one session
// proved with its device key, so a host that leaves does not leave a live
// identity behind. The connector of inst must be stopped first: a running
// one would take the link back. It returns the runtime id, empty when inst
// is not linked.
func retireLink(ctx context.Context, env cli.Env, inst layout.ConnectorInstance) (string, error) {
	lf, err := readLinkFile(inst)
	if err != nil || lf == nil {
		return "", err
	}
	if err := validateWSURL(lf.WSURL); err != nil {
		return lf.RuntimeID, err
	}
	if rotated, err := loadRotatedLinkToken(filepath.Join(stateDirOf(inst), "link-token.json"), lf.RuntimeID); err != nil {
		return lf.RuntimeID, fmt.Errorf("rotated link credential: %w", err)
	} else if rotated != "" {
		lf.LinkToken = rotated
	}
	if moved, err := loadMovedLinkOrigin(filepath.Join(stateDirOf(inst), "link-origin.json"), lf.RuntimeID); err != nil {
		return lf.RuntimeID, err
	} else if moved != "" {
		lf.WSURL = moved
	}
	key, err := retireDeviceKey(ctx, inst)
	if err != nil {
		return lf.RuntimeID, err
	}
	ctx, cancel := context.WithTimeout(ctx, retireTimeout)
	defer cancel()
	// No gateway and no bearer: a retiring session refuses every request.
	c := connector.New(lf.WSURL, connector.Auth{RuntimeID: lf.RuntimeID, LinkToken: lf.LinkToken}, "http://127.0.0.1:8642", "", nil)
	c.Agent = "edge-setup/" + env.Version
	c.HermesVersion = pins.HermesVersion
	c.DeviceKey = key
	if err := retireSession(ctx, c); err != nil {
		if ctx.Err() != nil {
			return lf.RuntimeID, fmt.Errorf("openedbot did not confirm within %s (an openedbot older than this tool ignores the request)", retireTimeout)
		}
		return lf.RuntimeID, err
	}
	return lf.RuntimeID, nil
}

// reportRetire runs retireLink and says what happened. A failure never stops
// the caller: the host still leaves, and the operator is told where to
// revoke the runtime by hand.
func reportRetire(ctx context.Context, env cli.Env, inst layout.ConnectorInstance) {
	id, err := retireLink(ctx, env, inst)
	switch {
	case err != nil && id == "":
		printf(env.Stderr, "warning: link %s could not be read to revoke its runtime: %v; %s", inst.Label(), err, retireManualHint)
	case err != nil:
		printf(env.Stderr, "warning: openedbot did not revoke runtime %s (link %s): %v; %s", id, inst.Label(), err, retireManualHint)
	case id != "":
		printf(env.Stdout, "openedbot revoked runtime %s (link %s): its identity can no longer reconnect", id, inst.Label())
	}
}

// existingDeviceKey reads the device key of inst without writing anything:
// nil when the instance never had one (a link older than proof of
// possession), an error when it exists but cannot be read.
func existingDeviceKey(ctx context.Context, inst layout.ConnectorInstance) (ed25519.PrivateKey, error) {
	if runtime.GOOS == "darwin" {
		store, err := devicekeys.New()
		if err != nil {
			return nil, err
		}
		key, err := readKeychainDeviceKey(ctx, store, inst)
		if errors.Is(err, devicekeys.ErrNotFound) {
			return nil, nil
		}
		return key, err
	}
	return unsealDeviceKey(ctx, inst)
}

// unsealDeviceKey has systemd-creds decrypt the sealed credential of inst.
func unsealDeviceKey(ctx context.Context, inst layout.ConnectorInstance) (ed25519.PrivateKey, error) {
	path := deviceKeyPathOf(inst)
	present, err := fsx.RequireRegular(path, 0o600, connectorOwner)
	if err != nil {
		return nil, errors.New("the sealed device key is not private, regular and owned by root")
	}
	if !present {
		return nil, nil
	}
	// The seed comes back on stdout only; never in an error or a log line.
	res, err := runner.Run(ctx, exec.Cmd{
		Path:    "/usr/bin/systemd-creds",
		Args:    []string{"decrypt", "--name=" + deviceKeyCredentialName, path, "-"},
		Timeout: 30 * time.Second,
	})
	if err != nil || res.ExitCode != 0 {
		return nil, errors.New("the sealed device key could not be unsealed")
	}
	key, err := enroll.ParseDeviceSeed([]byte(res.Stdout))
	if err != nil {
		return nil, errors.New("the unsealed device key is not an Ed25519 seed")
	}
	return key, nil
}

// retireLinkedInstances stops every linked connector and asks openedbot to
// revoke its runtime, before uninstall removes the links. With plan, it only
// says so.
func retireLinkedInstances(ctx context.Context, env cli.Env, plan bool) {
	for _, inst := range linkedInstances() {
		if plan {
			printf(env.Stdout, "would ask openedbot to revoke the runtime of link %s", inst.Label())
			continue
		}
		service, err := connectorService(inst)
		if err == nil {
			err = service.Stop(ctx)
		}
		if err != nil {
			printf(env.Stderr, "warning: %s could not be stopped, so its runtime was not revoked; %s", inst.Unit(), retireManualHint)
			continue
		}
		reportRetire(ctx, env, inst)
	}
}
