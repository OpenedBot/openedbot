package commands

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

type memoryDeviceKeys struct {
	seed                           []byte
	readErr, createErr, replaceErr error
	created, replaced              int
	instance                       layout.ConnectorInstance
}

func (s *memoryDeviceKeys) Read(_ context.Context, inst layout.ConnectorInstance) ([]byte, error) {
	s.instance = inst
	if s.readErr != nil {
		return nil, s.readErr
	}
	return append([]byte(nil), s.seed...), nil
}
func (s *memoryDeviceKeys) Create(_ context.Context, inst layout.ConnectorInstance, seed []byte) error {
	s.instance, s.created = inst, s.created+1
	if s.createErr != nil {
		return s.createErr
	}
	s.seed = append([]byte(nil), seed...)
	return nil
}
func (s *memoryDeviceKeys) Replace(_ context.Context, inst layout.ConnectorInstance, seed []byte) error {
	s.instance, s.replaced = inst, s.replaced+1
	if s.replaceErr != nil {
		return s.replaceErr
	}
	s.seed = append([]byte(nil), seed...)
	return nil
}

func TestKeychainUpgradePreservesAccessibleKey(t *testing.T) {
	priv, _ := enroll.GenerateDeviceKey()
	s := &memoryDeviceKeys{seed: priv.Seed()}
	generated := 0
	generate := func() (ed25519.PrivateKey, error) { generated++; return enroll.GenerateDeviceKey() }
	if err := ensureKeychainDeviceKey(context.Background(), s, "mac", generate); err != nil {
		t.Fatal(err)
	}
	if generated != 0 || s.created != 0 || s.replaced != 0 || !bytes.Equal(s.seed, priv.Seed()) {
		t.Fatal("upgrade changed an accessible existing key")
	}
	got, err := readKeychainDeviceKey(context.Background(), s, "mac")
	if err != nil || !got.Equal(priv) || s.instance != "mac" {
		t.Fatalf("identity not preserved: %v", err)
	}
}

func TestKeychainAccessFailureNeverGeneratesOrOverwritesIdentity(t *testing.T) {
	priv, _ := enroll.GenerateDeviceKey()
	accessErr := errors.New("Keychain access refused")
	s := &memoryDeviceKeys{seed: priv.Seed(), readErr: accessErr}
	generated := 0
	generate := func() (ed25519.PrivateKey, error) { generated++; return enroll.GenerateDeviceKey() }
	if err := ensureKeychainDeviceKey(context.Background(), s, "mac", generate); !errors.Is(err, accessErr) {
		t.Fatal(err)
	}
	replacement, _ := enroll.GenerateDeviceKey()
	if err := persistKeychainDeviceKey(context.Background(), s, "mac", replacement); !errors.Is(err, accessErr) {
		t.Fatal(err)
	}
	if generated != 0 || s.created != 0 || s.replaced != 0 || !bytes.Equal(s.seed, priv.Seed()) {
		t.Fatal("an inaccessible key was treated as absent")
	}
}

func TestKeychainOnlyConfirmedAbsenceCreatesIdentity(t *testing.T) {
	s := &memoryDeviceKeys{readErr: devicekeys.ErrNotFound}
	priv, _ := enroll.GenerateDeviceKey()
	wantSeed := priv.Seed()
	if err := ensureKeychainDeviceKey(context.Background(), s, "dev", func() (ed25519.PrivateKey, error) { return priv, nil }); err != nil {
		t.Fatal(err)
	}
	if s.created != 1 || s.replaced != 0 || !bytes.Equal(s.seed, wantSeed) || s.instance != "dev" {
		t.Fatal("missing key was not created for the exact instance")
	}
}

func TestKeychainCreateRacePreservesConcurrentIdentity(t *testing.T) {
	concurrent, _ := enroll.GenerateDeviceKey()
	s := &memoryDeviceKeys{seed: concurrent.Seed(), readErr: devicekeys.ErrNotFound, createErr: devicekeys.ErrDuplicate}
	if err := ensureKeychainDeviceKey(context.Background(), s, "dev", enroll.GenerateDeviceKey); !errors.Is(err, devicekeys.ErrDuplicate) {
		t.Fatal(err)
	}
	if s.created != 1 || s.replaced != 0 || !bytes.Equal(s.seed, concurrent.Seed()) {
		t.Fatal("creation race overwrote the concurrent identity")
	}
}

func TestKeychainExplicitRotationReplacesOnlyAccessibleIdentity(t *testing.T) {
	previous, _ := enroll.GenerateDeviceKey()
	replacement, _ := enroll.GenerateDeviceKey()
	s := &memoryDeviceKeys{seed: previous.Seed()}
	if err := persistKeychainDeviceKey(context.Background(), s, "mac", replacement); err != nil {
		t.Fatal(err)
	}
	if s.created != 0 || s.replaced != 1 || !bytes.Equal(s.seed, replacement.Seed()) {
		t.Fatal("explicit replacement not stored")
	}
	s.replaceErr = devicekeys.ErrNotFound
	if err := persistKeychainDeviceKey(context.Background(), s, "mac", previous); !errors.Is(err, devicekeys.ErrNotFound) {
		t.Fatal(err)
	}
	if s.created != 0 || !bytes.Equal(s.seed, replacement.Seed()) {
		t.Fatal("replacement race silently recreated an entry")
	}
}

func TestKeychainMalformedIdentityCannotBecomeANewKey(t *testing.T) {
	s := &memoryDeviceKeys{seed: []byte("malformed")}
	if err := ensureKeychainDeviceKey(context.Background(), s, "dev", enroll.GenerateDeviceKey); !errors.Is(err, devicekeys.ErrInvalidSeed) {
		t.Fatal(err)
	}
	if err := persistKeychainDeviceKey(context.Background(), s, "dev", nil); !errors.Is(err, devicekeys.ErrInvalidSeed) {
		t.Fatal(err)
	}
	if s.created != 0 || s.replaced != 0 {
		t.Fatal("malformed identity was overwritten")
	}
}
