package devicekeys

import (
	"context"
	"testing"
)

func TestInventoryExposesAttributesWithoutResetOrEnrollmentOperations(t *testing.T) {
	api := &fakeSecItemResetAPI{accountNames: []string{"orphan", "default"}}
	var inventory Inventory = &keychainInventory{api: api}
	if _, ok := inventory.(ResetStore); ok {
		t.Fatal("read-only inventory grants removal")
	}
	if _, ok := inventory.(Store); ok {
		t.Fatal("read-only inventory grants enrollment writes")
	}
	instances, err := inventory.Instances(context.Background())
	if err != nil || len(instances) != 2 {
		t.Fatalf("inventory: %v", err)
	}
	if len(api.calls) != 1 || api.calls[0] != (resetAPICall{method: "accounts", service: serviceName}) {
		t.Fatal("inventory queried key data or modified an item")
	}
}
