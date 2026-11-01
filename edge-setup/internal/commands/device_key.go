package commands

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// The device key is the host's proof of possession on the link
// (docs/CONNECTOR.md « Preuve de possession »). Its seed is sealed by
// systemd-creds, bound to the TPM when the host has one, to the host key
// otherwise, and unsealed by PID 1 into the connector's
// CREDENTIALS_DIRECTORY. This package never writes the seed in clear: the
// plaintext goes to systemd-creds on stdin and comes back sealed on stdout.
// macOS stores the seed in the user's Keychain under the same instance
// identity. An inaccessible existing entry never permits a new identity.

// tpmDevice is what makes systemd-creds bind the credential to the TPM2.
var tpmDevice = "/dev/tpmrm0"

// deviceKeyCredentialName is the id under which the unit loads it.
const deviceKeyCredentialName = "device.key"

// deviceKeyWithKey picks the systemd-creds sealing key.
func deviceKeyWithKey() string {
	if fsx.Exists(tpmDevice) {
		return "tpm2"
	}
	return "host"
}

// sealDeviceKey encrypts the seed with systemd-creds and writes the sealed
// credential of the instance, 0600 root. Nothing else touches the disk.
func sealDeviceKey(ctx context.Context, r exec.Runner, inst layout.ConnectorInstance, priv ed25519.PrivateKey) (string, error) {
	if runtime.GOOS == "darwin" {
		store, err := devicekeys.New()
		if err != nil {
			return "", err
		}
		if err := persistKeychainDeviceKey(ctx, store, inst, priv); err != nil {
			return "", err
		}
		return "macOS Keychain", nil
	}
	deviceKeyPath := deviceKeyPathOf(inst)
	with := deviceKeyWithKey()
	res, err := exec.Must(ctx, r, exec.Cmd{
		Path:  "/usr/bin/systemd-creds",
		Args:  []string{"encrypt", "--name=" + deviceKeyCredentialName, "--with-key=" + with, "-", "-"},
		Stdin: enroll.EncodeDeviceSeed(priv),
	})
	if err != nil {
		return "", fmt.Errorf("seal device key: %w", err)
	}
	if len(res.Stdout) == 0 {
		return "", errors.New("seal device key: systemd-creds produced no credential")
	}
	if err := fsx.EnsureDir(filepath.Dir(deviceKeyPath), 0o700, connectorOwner); err != nil {
		return "", err
	}
	if err := fsx.WriteAtomic(deviceKeyPath, []byte(res.Stdout), 0o600, connectorOwner); err != nil {
		return "", err
	}
	return with, nil
}

// newDeviceKey generates and stores a fresh key; the private half stays in
// memory for the session that presents it.
func newDeviceKey(ctx context.Context, r exec.Runner, inst layout.ConnectorInstance, log func(string, ...any)) (ed25519.PrivateKey, error) {
	priv, err := enroll.GenerateDeviceKey()
	if err != nil {
		return nil, err
	}
	with, err := sealDeviceKey(ctx, r, inst, priv)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS == "darwin" {
		log("device key stored in %s for instance %s", with, inst.Label())
	} else {
		log("device key sealed with the %s key (%s)", with, deviceKeyPathOf(inst))
	}
	return priv, nil
}

// ensureDeviceKeys creates the sealed credential of every linked instance
// that lacks one (a host linked before proof of possession existed, upgraded
// in place). An instance that already has a key keeps it: a new key would
// be refused by openedbot until `link --rekey`. The public half of a new
// key reaches openedbot in the next hello.
func ensureDeviceKeys(ctx context.Context, r exec.Runner, log func(string, ...any)) error {
	if runtime.GOOS == "darwin" {
		store, err := devicekeys.New()
		if err != nil {
			return err
		}
		for _, inst := range linkedInstances() {
			if err := ensureKeychainDeviceKey(ctx, store, inst, enroll.GenerateDeviceKey); err != nil {
				return fmt.Errorf("instance %s: %w", inst.Label(), err)
			}
		}
		return nil
	}
	for _, inst := range linkedInstances() {
		if fsx.Exists(deviceKeyPathOf(inst)) {
			continue
		}
		if _, err := newDeviceKey(ctx, r, inst, log); err != nil {
			return fmt.Errorf("instance %s: %w", inst.Label(), err)
		}
	}
	return nil
}

// loadDeviceKey reads the seed systemd unsealed into CREDENTIALS_DIRECTORY.
func loadDeviceKey(credDir string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(filepath.Join(credDir, deviceKeyCredentialName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("device.key credential is missing: the unit was rendered before proof of possession existed, or the key was never sealed; run `edge-setup up --yes` (re-renders the unit) then `edge-setup link --rekey --yes`")
	}
	if err != nil {
		return nil, fmt.Errorf("device.key credential: %w", err)
	}
	priv, err := enroll.ParseDeviceSeed(data)
	if err != nil {
		return nil, fmt.Errorf("device.key credential: %w", err)
	}
	return priv, nil
}

// preflightDeviceKey checks access before enrollment spends a ticket or
// rekey stops a running connector. Only a confirmed absent item is allowed.
func preflightDeviceKey(ctx context.Context, inst layout.ConnectorInstance) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	store, err := devicekeys.New()
	if err != nil {
		return err
	}
	_, err = readKeychainDeviceKey(ctx, store, inst)
	if errors.Is(err, devicekeys.ErrNotFound) {
		return nil
	}
	return err
}

func loadInstanceDeviceKey(ctx context.Context, inst layout.ConnectorInstance, credDir string) (ed25519.PrivateKey, error) {
	if runtime.GOOS != "darwin" {
		return loadDeviceKey(credDir)
	}
	store, err := devicekeys.New()
	if err != nil {
		return nil, err
	}
	return readKeychainDeviceKey(ctx, store, inst)
}

func readKeychainDeviceKey(ctx context.Context, store devicekeys.Store, inst layout.ConnectorInstance) (ed25519.PrivateKey, error) {
	seed, err := store.Read(ctx, inst)
	defer clear(seed)
	if err != nil {
		return nil, err
	}
	if len(seed) != ed25519.SeedSize {
		return nil, devicekeys.ErrInvalidSeed
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// persistKeychainDeviceKey belongs only to explicit enrollment and rekey.
// A read error cannot be treated as absence, even for these writes.
func persistKeychainDeviceKey(ctx context.Context, store devicekeys.Store, inst layout.ConnectorInstance, priv ed25519.PrivateKey) error {
	if len(priv) != ed25519.PrivateKeySize {
		return devicekeys.ErrInvalidSeed
	}
	seed := priv.Seed()
	defer clear(seed)
	_, err := readKeychainDeviceKey(ctx, store, inst)
	if errors.Is(err, devicekeys.ErrNotFound) {
		return store.Create(ctx, inst, seed)
	}
	if err != nil {
		return err
	}
	return store.Replace(ctx, inst, seed)
}

// ensureKeychainDeviceKey preserves identities during upgrades. A create
// race is reported; it never overwrites the key installed by another process.
func ensureKeychainDeviceKey(ctx context.Context, store devicekeys.Store, inst layout.ConnectorInstance, generate func() (ed25519.PrivateKey, error)) error {
	_, err := readKeychainDeviceKey(ctx, store, inst)
	if err == nil {
		return nil
	}
	if !errors.Is(err, devicekeys.ErrNotFound) {
		return err
	}
	priv, err := generate()
	if err != nil {
		return err
	}
	if len(priv) != ed25519.PrivateKeySize {
		return devicekeys.ErrInvalidSeed
	}
	defer clear(priv)
	seed := priv.Seed()
	defer clear(seed)
	return store.Create(ctx, inst, seed)
}
