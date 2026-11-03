package devicekeys

import (
	"context"
	"errors"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// ResetStore is used only by an explicitly confirmed installation reset.
// Enrollment's Store deliberately has no destructive operation.
type ResetStore interface {
	Inventory
	Remove(context.Context, layout.ConnectorInstance) error
}

type secItemResetAPI interface {
	secItemInventoryAPI
	remove(service, account string) (secStatus, error)
	copy(service, account string) ([]byte, secStatus, error)
}

type keychainResetStore struct {
	keychainInventory
	api secItemResetAPI
}

var ErrRemovalVerification = errors.New("device key removal could not be verified")

func NewResetStore() (ResetStore, error) {
	api, err := newNativeSecItemAPI()
	if err != nil {
		return nil, err
	}
	remover, ok := api.(secItemResetAPI)
	if !ok {
		return nil, ErrUnsupported
	}
	return newResetStore(remover), nil
}

func newResetStore(api secItemResetAPI) *keychainResetStore {
	return &keychainResetStore{keychainInventory: keychainInventory{api: api}, api: api}
}

// Remove targets one exact service/account query and proves absence by
// re-reading it. A failed or unreadable result is never treated as absent.
func (s *keychainResetStore) Remove(ctx context.Context, instance layout.ConnectorInstance) error {
	account, err := validateInstance(instance)
	if err != nil {
		return err
	}
	if err := checkContext(ctx); err != nil {
		return err
	}
	if s.api == nil {
		return errors.New("macOS reset key removal is unavailable")
	}
	status, err := s.api.remove(serviceName, account)
	if err != nil || (status != statusSuccess && status != statusItemNotFound) {
		return errors.New("macOS reset device key could not be removed")
	}
	if err := checkContext(ctx); err != nil {
		return err
	}
	data, status, err := s.api.copy(serviceName, account)
	hadData := len(data) != 0
	wipe(data)
	if err != nil || status != statusItemNotFound || hadData {
		return ErrRemovalVerification
	}
	return nil
}
