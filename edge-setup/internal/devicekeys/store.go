// Package devicekeys stores connector proof-of-possession seeds in the native
// macOS keychain. It does not store runtime credentials or link tokens.
package devicekeys

import (
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"errors"
	"fmt"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

const serviceName = "com.openhermesbot.edge-setup.device-key"

const (
	statusSuccess       secStatus = 0
	statusDuplicateItem secStatus = -25299
	statusItemNotFound  secStatus = -25300
)

var (
	// ErrNotFound means SecItem reported errSecItemNotFound for the exact
	// service and account query.
	ErrNotFound = errors.New("device key not found")
	// ErrDuplicate means a different device seed already occupies this
	// connector instance's keychain account.
	ErrDuplicate = errors.New("a different device key already exists")
	// ErrInvalidSeed means a seed was not exactly one Ed25519 seed in size.
	ErrInvalidSeed = errors.New("device key must be a 32-byte Ed25519 seed")
	// ErrVerification means a successful keychain write did not read back as requested.
	ErrVerification = errors.New("device key write could not be verified")
	// ErrUnsupported is returned where a native macOS keychain backend is absent.
	ErrUnsupported = errors.New("native device key storage is unsupported on this operating system")
)

// Store is the connector's narrow device-key storage contract. Replace is
// explicit and update-only: it never creates a missing keychain item.
type Store interface {
	Create(context.Context, layout.ConnectorInstance, []byte) error
	Read(context.Context, layout.ConnectorInstance) ([]byte, error)
	Replace(context.Context, layout.ConnectorInstance, []byte) error
}

type secStatus int32

// secItemAPI is deliberately narrower than SecItem. In particular, it has no
// delete operation, so an access failure cannot silently erase and reseed a
// connector identity.
type secItemAPI interface {
	add(service, account string, seed []byte) (secStatus, error)
	copy(service, account string) ([]byte, secStatus, error)
	update(service, account string, seed []byte) (secStatus, error)
}

type keychainStore struct {
	api secItemAPI
}

// New returns the native device-key store on macOS. Other operating systems
// return ErrUnsupported and keep using their existing credential backend.
func New() (Store, error) {
	api, err := newNativeSecItemAPI()
	if err != nil {
		return nil, err
	}
	return newKeychainStore(api), nil
}

func newKeychainStore(api secItemAPI) *keychainStore {
	return &keychainStore{api: api}
}

func (s *keychainStore) Create(ctx context.Context, instance layout.ConnectorInstance, seed []byte) error {
	account, err := validateInstance(instance)
	if err != nil {
		return err
	}
	if len(seed) != ed25519.SeedSize {
		return ErrInvalidSeed
	}
	if err := checkContext(ctx); err != nil {
		return err
	}
	status, err := s.api.add(serviceName, account, seed)
	if err != nil {
		return fmt.Errorf("add device key to macOS keychain: %w", err)
	}
	if status == statusSuccess {
		stored, err := s.Read(ctx, instance)
		if err != nil {
			return fmt.Errorf("verify added device key: %w", err)
		}
		same := subtle.ConstantTimeCompare(stored, seed) == 1
		wipe(stored)
		if !same {
			return ErrVerification
		}
		return nil
	}
	if status != statusDuplicateItem {
		return statusError("add", status)
	}

	// Duplicate creates are idempotent only when the occupied account holds the
	// same seed. An inaccessible or malformed existing item remains untouched.
	existing, readStatus, err := s.api.copy(serviceName, account)
	if err != nil {
		wipe(existing)
		return fmt.Errorf("read existing device key after duplicate: %w", err)
	}
	if readStatus == statusItemNotFound {
		wipe(existing)
		return ErrNotFound
	}
	if readStatus != statusSuccess {
		wipe(existing)
		return statusError("read existing item after duplicate", readStatus)
	}
	if len(existing) != ed25519.SeedSize {
		wipe(existing)
		return ErrInvalidSeed
	}
	same := subtle.ConstantTimeCompare(existing, seed) == 1
	wipe(existing)
	if !same {
		return ErrDuplicate
	}
	return nil
}

func (s *keychainStore) Read(ctx context.Context, instance layout.ConnectorInstance) ([]byte, error) {
	account, err := validateInstance(instance)
	if err != nil {
		return nil, err
	}
	if err := checkContext(ctx); err != nil {
		return nil, err
	}
	seed, status, err := s.api.copy(serviceName, account)
	if err != nil {
		wipe(seed)
		return nil, fmt.Errorf("read device key from macOS keychain: %w", err)
	}
	if status == statusItemNotFound {
		wipe(seed)
		return nil, ErrNotFound
	}
	if status != statusSuccess {
		wipe(seed)
		return nil, statusError("read", status)
	}
	if len(seed) != ed25519.SeedSize {
		wipe(seed)
		return nil, ErrInvalidSeed
	}
	return seed, nil
}

func (s *keychainStore) Replace(ctx context.Context, instance layout.ConnectorInstance, seed []byte) error {
	account, err := validateInstance(instance)
	if err != nil {
		return err
	}
	if len(seed) != ed25519.SeedSize {
		return ErrInvalidSeed
	}
	if err := checkContext(ctx); err != nil {
		return err
	}
	status, err := s.api.update(serviceName, account, seed)
	if err != nil {
		return fmt.Errorf("replace device key in macOS keychain: %w", err)
	}
	if status == statusItemNotFound {
		return ErrNotFound
	}
	if status != statusSuccess {
		return statusError("replace", status)
	}

	stored, err := s.Read(ctx, instance)
	if err != nil {
		return fmt.Errorf("verify replaced device key: %w", err)
	}
	same := subtle.ConstantTimeCompare(stored, seed) == 1
	wipe(stored)
	if !same {
		return ErrVerification
	}
	return nil
}

func validateInstance(instance layout.ConnectorInstance) (string, error) {
	validated, err := layout.ParseConnectorInstance(string(instance))
	if err != nil || validated != instance {
		return "", errors.New("invalid connector instance")
	}
	return validated.Label(), nil
}

func checkContext(ctx context.Context) error {
	if ctx == nil {
		return errors.New("context is required")
	}
	return ctx.Err()
}

func statusError(operation string, status secStatus) error {
	return fmt.Errorf("macOS keychain %s failed with OSStatus %d", operation, status)
}

func wipe(data []byte) {
	for i := range data {
		data[i] = 0
	}
}
