package devicekeys

import (
	"bytes"
	"context"
	"sort"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// fakeMigrationAPI is a keychain holding items under both service names.
type fakeMigrationAPI struct {
	*fakeSecItemAPI
	removeFails bool
}

func (f *fakeMigrationAPI) accounts(service string) ([]string, secStatus, error) {
	var out []string
	for id := range f.items {
		if id.service == service {
			out = append(out, id.account)
		}
	}
	sort.Strings(out)
	if len(out) == 0 {
		return nil, statusItemNotFound, nil
	}
	return out, statusSuccess, nil
}

func (f *fakeMigrationAPI) remove(service, account string) (secStatus, error) {
	if f.removeFails {
		return -1, nil
	}
	delete(f.items, itemID{service: service, account: account})
	return statusSuccess, nil
}

func newFakeMigrationAPI(items map[itemID][]byte) *fakeMigrationAPI {
	api := &fakeMigrationAPI{fakeSecItemAPI: newFakeSecItemAPI()}
	for id, seed := range items {
		api.items[id] = seed
	}
	return api
}

func TestMigrateLegacyUsesTheRenamedServices(t *testing.T) {
	if serviceName != "app.openedbot.edge-setup.device-key" || legacyServiceName != "com.openhermesbot.edge-setup.device-key" {
		t.Fatalf("keychain services = %q, %q", serviceName, legacyServiceName)
	}
}

func TestMigrateLegacyMovesEachKeyAndRemovesTheLegacyItemAfterProof(t *testing.T) {
	api := newFakeMigrationAPI(map[itemID][]byte{
		{legacyServiceName, "default"}: seedWith(0x11),
		{legacyServiceName, "work"}:    seedWith(0x22),
		// Already copied by an interrupted run: same seed, only the legacy item remains to drop.
		{serviceName, "work"}: seedWith(0x22),
	})
	moved, err := migrateLegacy(context.Background(), api)
	if err != nil {
		t.Fatal(err)
	}
	if len(moved) != 2 || moved[0] != layout.DefaultConnectorInstance || moved[1] != "work" {
		t.Fatalf("moved = %q", moved)
	}
	for account, value := range map[string]byte{"default": 0x11, "work": 0x22} {
		if !bytes.Equal(api.items[itemID{serviceName, account}], seedWith(value)) {
			t.Fatalf("%s was not stored under the current service", account)
		}
		if _, ok := api.items[itemID{legacyServiceName, account}]; ok {
			t.Fatalf("legacy item %s remains", account)
		}
	}
	again, err := migrateLegacy(context.Background(), api)
	if err != nil || len(again) != 0 {
		t.Fatalf("second migration = %q, %v", again, err)
	}
}

func TestMigrateLegacyKeepsBothItemsWhenSeedsDiffer(t *testing.T) {
	api := newFakeMigrationAPI(map[itemID][]byte{
		{legacyServiceName, "default"}: seedWith(0x11),
		{serviceName, "default"}:       seedWith(0x99),
	})
	moved, err := migrateLegacy(context.Background(), api)
	if err == nil || !strings.Contains(err.Error(), "both were preserved") || len(moved) != 0 {
		t.Fatalf("conflict was not refused: %q, %v", moved, err)
	}
	if !bytes.Equal(api.items[itemID{legacyServiceName, "default"}], seedWith(0x11)) || !bytes.Equal(api.items[itemID{serviceName, "default"}], seedWith(0x99)) {
		t.Fatal("a conflicting device key was changed")
	}
}

func TestMigrateLegacyKeepsTheLegacyItemWhenItsRemovalFails(t *testing.T) {
	api := newFakeMigrationAPI(map[itemID][]byte{{legacyServiceName, "default"}: seedWith(0x11)})
	api.removeFails = true
	if _, err := migrateLegacy(context.Background(), api); err == nil {
		t.Fatal("unproved legacy removal was accepted")
	}
	if !bytes.Equal(api.items[itemID{serviceName, "default"}], seedWith(0x11)) || !bytes.Equal(api.items[itemID{legacyServiceName, "default"}], seedWith(0x11)) {
		t.Fatal("device key is not in both places after a failed removal")
	}
}

func TestMigrateLegacyWithoutLegacyKeysDoesNothing(t *testing.T) {
	api := newFakeMigrationAPI(map[itemID][]byte{{serviceName, "default"}: seedWith(0x11)})
	moved, err := migrateLegacy(context.Background(), api)
	if err != nil || len(moved) != 0 || api.addCalls != 0 || len(api.items) != 1 {
		t.Fatalf("migration without legacy keys changed the keychain: %q, %v", moved, err)
	}
}
