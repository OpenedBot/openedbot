package devicekeys

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

type secItemMigrationAPI interface {
	secItemAPI
	secItemResetAPI
}

// MigrateLegacy moves every device key stored under the pre-rename keychain
// service to the current one. Each seed is written and read back under the
// current service before its legacy item is removed, so an interruption
// leaves a key in at least one place. A different seed already stored under
// the current service is refused and both items are kept.
func MigrateLegacy(ctx context.Context) ([]layout.ConnectorInstance, error) {
	api, err := newNativeSecItemAPI()
	if err != nil {
		return nil, err
	}
	migrator, ok := api.(secItemMigrationAPI)
	if !ok {
		return nil, ErrUnsupported
	}
	return migrateLegacy(ctx, migrator)
}

func migrateLegacy(ctx context.Context, api secItemMigrationAPI) ([]layout.ConnectorInstance, error) {
	legacy := newResetStore(api)
	legacy.service = legacyServiceName
	instances, err := legacy.Instances(ctx)
	if err != nil {
		return nil, errors.New("legacy device key inventory could not be verified; nothing was moved")
	}
	current := newKeychainStore(api)
	moved := make([]layout.ConnectorInstance, 0, len(instances))
	for _, inst := range instances {
		account, err := validateInstance(inst)
		if err != nil {
			return moved, err
		}
		seed, status, err := api.copy(legacyServiceName, account)
		if err != nil || status != statusSuccess || len(seed) != ed25519.SeedSize {
			wipe(seed)
			return moved, fmt.Errorf("legacy device key of instance %s is inaccessible; it was preserved", inst.Label())
		}
		err = current.Create(ctx, inst, seed)
		wipe(seed)
		if errors.Is(err, ErrDuplicate) {
			return moved, fmt.Errorf("instance %s has different device keys under the legacy and current names; both were preserved", inst.Label())
		}
		if err != nil {
			return moved, fmt.Errorf("device key of instance %s could not be copied to the current name; the legacy key was preserved", inst.Label())
		}
		if err := legacy.Remove(ctx, inst); err != nil {
			return moved, fmt.Errorf("device key of instance %s was copied but its legacy item could not be removed", inst.Label())
		}
		moved = append(moved, inst)
	}
	return moved, nil
}
