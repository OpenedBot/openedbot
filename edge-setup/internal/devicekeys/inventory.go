package devicekeys

import (
	"context"
	"errors"
	"sort"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// Inventory exposes account attributes without granting removal or key writes.
type Inventory interface {
	Instances(context.Context) ([]layout.ConnectorInstance, error)
}

type secItemInventoryAPI interface {
	accounts(service string) ([]string, secStatus, error)
}

type keychainInventory struct{ api secItemInventoryAPI }

func NewInventory() (Inventory, error) {
	api, err := newNativeSecItemAPI()
	if err != nil {
		return nil, err
	}
	reader, ok := api.(secItemInventoryAPI)
	if !ok {
		return nil, ErrUnsupported
	}
	return &keychainInventory{api: reader}, nil
}

// Instances lists account attributes only, including orphaned device keys.
func (s *keychainInventory) Instances(ctx context.Context) ([]layout.ConnectorInstance, error) {
	if err := checkContext(ctx); err != nil {
		return nil, err
	}
	if s.api == nil {
		return nil, errors.New("macOS key inventory is unavailable")
	}
	accounts, status, err := s.api.accounts(serviceName)
	if err != nil || (status != statusSuccess && status != statusItemNotFound) || len(accounts) > 256 || (status == statusItemNotFound && len(accounts) != 0) {
		return nil, errors.New("macOS key inventory could not be verified")
	}
	instances := make([]layout.ConnectorInstance, 0, len(accounts))
	seen := map[layout.ConnectorInstance]bool{}
	for _, account := range accounts {
		name := account
		if account == "default" {
			name = ""
		}
		instance, err := layout.ParseConnectorInstance(name)
		if err != nil || instance.Label() != account || seen[instance] {
			return nil, errors.New("macOS key inventory contains an invalid or ambiguous account")
		}
		seen[instance] = true
		instances = append(instances, instance)
	}
	sort.Slice(instances, func(i, j int) bool { return instances[i] < instances[j] })
	return instances, nil
}
