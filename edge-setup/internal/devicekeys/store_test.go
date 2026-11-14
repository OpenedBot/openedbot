package devicekeys

import (
	"context"
	"crypto/ed25519"
	"errors"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

type itemID struct {
	service string
	account string
}

type fakeSecItemAPI struct {
	items map[itemID][]byte

	addStatus      secStatus
	copyStatus     secStatus
	copyOverride   bool
	copyData       []byte
	updateStatus   secStatus
	updateOverride bool
	apiErr         error

	addCalls    int
	copyCalls   int
	updateCalls int
	lastItem    itemID
}

func newFakeSecItemAPI() *fakeSecItemAPI {
	return &fakeSecItemAPI{items: make(map[itemID][]byte)}
}

func (f *fakeSecItemAPI) add(service, account string, seed []byte) (secStatus, error) {
	f.addCalls++
	f.lastItem = itemID{service: service, account: account}
	if f.apiErr != nil {
		return 0, f.apiErr
	}
	if f.addStatus != statusSuccess {
		return f.addStatus, nil
	}
	id := itemID{service: service, account: account}
	if _, exists := f.items[id]; exists {
		return statusDuplicateItem, nil
	}
	f.items[id] = append([]byte(nil), seed...)
	return statusSuccess, nil
}

func (f *fakeSecItemAPI) copy(service, account string) ([]byte, secStatus, error) {
	f.copyCalls++
	f.lastItem = itemID{service: service, account: account}
	if f.apiErr != nil {
		return nil, 0, f.apiErr
	}
	if f.copyOverride {
		return append([]byte(nil), f.copyData...), f.copyStatus, nil
	}
	id := itemID{service: service, account: account}
	data, exists := f.items[id]
	if !exists {
		return nil, statusItemNotFound, nil
	}
	return append([]byte(nil), data...), statusSuccess, nil
}

func (f *fakeSecItemAPI) update(service, account string, seed []byte) (secStatus, error) {
	f.updateCalls++
	f.lastItem = itemID{service: service, account: account}
	if f.apiErr != nil {
		return 0, f.apiErr
	}
	if f.updateOverride {
		return f.updateStatus, nil
	}
	id := itemID{service: service, account: account}
	if _, exists := f.items[id]; !exists {
		return statusItemNotFound, nil
	}
	f.items[id] = append([]byte(nil), seed...)
	return statusSuccess, nil
}

func seedWith(value byte) []byte {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = value
	}
	return seed
}

func TestCreateReadAndDuplicateDoNotReplaceAnExistingSeed(t *testing.T) {
	api := newFakeSecItemAPI()
	store := newKeychainStore(api)
	first := seedWith(0x11)
	ctx := context.Background()

	if err := store.Create(ctx, layout.DefaultConnectorInstance, first); err != nil {
		t.Fatal(err)
	}
	if api.lastItem != (itemID{service: serviceName, account: "default"}) {
		t.Fatalf("default keychain identity = %+v", api.lastItem)
	}
	if err := store.Create(ctx, layout.DefaultConnectorInstance, first); err != nil {
		t.Fatalf("same-seed duplicate should be idempotent: %v", err)
	}
	if err := store.Create(ctx, layout.DefaultConnectorInstance, seedWith(0x22)); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("different-seed duplicate error = %v, want ErrDuplicate", err)
	}
	got, err := store.Read(ctx, layout.DefaultConnectorInstance)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(first) {
		t.Fatal("duplicate create replaced the existing seed")
	}
	wipe(got)
	if api.items[itemID{service: serviceName, account: "default"}][0] != 0x11 {
		t.Fatal("stored seed changed after a duplicate create")
	}
}

func TestReadMapsOnlyItemNotFoundToAbsence(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    secStatus
		wantFound bool
	}{
		{name: "not found", status: statusItemNotFound, wantFound: true},
		{name: "interaction not allowed", status: secStatus(-25308)},
		{name: "other keychain error", status: secStatus(-25291)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newFakeSecItemAPI()
			api.copyOverride = true
			api.copyStatus = tc.status
			store := newKeychainStore(api)
			_, err := store.Read(context.Background(), "blue")
			if tc.wantFound {
				if !errors.Is(err, ErrNotFound) {
					t.Fatalf("Read() error = %v, want ErrNotFound", err)
				}
			} else if err == nil || errors.Is(err, ErrNotFound) {
				t.Fatalf("Read() error = %v, inaccessible item must remain an error", err)
			}
		})
	}
}

func TestCreatePreservesAnExistingInaccessibleKey(t *testing.T) {
	api := newFakeSecItemAPI()
	id := itemID{service: serviceName, account: "blue"}
	api.items[id] = seedWith(0x31)
	api.copyOverride = true
	api.copyStatus = secStatus(-25308)
	store := newKeychainStore(api)

	err := store.Create(context.Background(), "blue", seedWith(0x42))
	if err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Create() error = %v, existing inaccessible item must not look absent", err)
	}
	if api.addCalls != 1 || api.copyCalls != 1 || api.updateCalls != 0 {
		t.Fatalf("unexpected keychain calls: add=%d copy=%d update=%d", api.addCalls, api.copyCalls, api.updateCalls)
	}
	if api.items[id][0] != 0x31 {
		t.Fatal("inaccessible existing seed was overwritten")
	}
}

func TestCreateRequiresAccessibleMatchingReadbackAfterAdd(t *testing.T) {
	t.Run("readback inaccessible", func(t *testing.T) {
		api := newFakeSecItemAPI()
		api.copyOverride = true
		api.copyStatus = secStatus(-25308)
		store := newKeychainStore(api)
		seed := seedWith(0x43)
		err := store.Create(context.Background(), "blue", seed)
		if err == nil || errors.Is(err, ErrNotFound) {
			t.Fatalf("Create() error = %v, want inaccessible readback error", err)
		}
		if api.addCalls != 1 || api.copyCalls != 1 {
			t.Fatalf("calls after inaccessible readback: add=%d copy=%d", api.addCalls, api.copyCalls)
		}
		if api.items[itemID{service: serviceName, account: "blue"}][0] != 0x43 {
			t.Fatal("failed readback removed or changed the key")
		}
	})

	t.Run("readback differs", func(t *testing.T) {
		api := newFakeSecItemAPI()
		api.copyOverride = true
		api.copyStatus = statusSuccess
		api.copyData = seedWith(0x44)
		store := newKeychainStore(api)
		seed := seedWith(0x45)
		if err := store.Create(context.Background(), "blue", seed); !errors.Is(err, ErrVerification) {
			t.Fatalf("Create() error = %v, want ErrVerification", err)
		}
		if api.items[itemID{service: serviceName, account: "blue"}][0] != 0x45 {
			t.Fatal("verification failure deleted or changed the added key")
		}
	})
}

func TestReplaceIsUpdateOnlyAndVerifiesTheSeed(t *testing.T) {
	api := newFakeSecItemAPI()
	store := newKeychainStore(api)
	ctx := context.Background()
	seed := seedWith(0x51)
	if err := store.Replace(ctx, "green", seed); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replace of missing key = %v, want ErrNotFound", err)
	}
	if api.addCalls != 0 {
		t.Fatal("Replace created a missing keychain item")
	}

	if err := store.Create(ctx, "green", seedWith(0x52)); err != nil {
		t.Fatal(err)
	}
	if err := store.Replace(ctx, "green", seed); err != nil {
		t.Fatal(err)
	}
	got, err := store.Read(ctx, "green")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(seed) {
		t.Fatal("Replace did not persist the requested seed")
	}
	wipe(got)
	if api.updateCalls != 2 {
		t.Fatalf("update calls = %d, want missing and existing attempts", api.updateCalls)
	}
}

func TestReplacePreservesExistingSeedWhenKeychainRefusesUpdate(t *testing.T) {
	api := newFakeSecItemAPI()
	store := newKeychainStore(api)
	ctx := context.Background()
	oldSeed := seedWith(0x53)
	newSeed := seedWith(0x54)
	if err := store.Create(ctx, "orange", oldSeed); err != nil {
		t.Fatal(err)
	}
	api.updateOverride = true
	api.updateStatus = secStatus(-25308)
	if err := store.Replace(ctx, "orange", newSeed); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Replace() error = %v, want keychain access error", err)
	}
	stored := api.items[itemID{service: serviceName, account: "orange"}]
	if string(stored) != string(oldSeed) {
		t.Fatal("keychain access failure changed the existing seed")
	}
	if api.addCalls != 1 || api.updateCalls != 1 {
		t.Fatalf("unexpected calls: add=%d update=%d", api.addCalls, api.updateCalls)
	}
}

func TestOperationsRejectNonSeedInputsBeforeCallingKeychain(t *testing.T) {
	api := newFakeSecItemAPI()
	store := newKeychainStore(api)
	ctx := context.Background()
	for _, op := range []func() error{
		func() error { return store.Create(ctx, "blue", make([]byte, ed25519.PrivateKeySize)) },
		func() error { return store.Replace(ctx, "blue", make([]byte, ed25519.SeedSize-1)) },
	} {
		if err := op(); !errors.Is(err, ErrInvalidSeed) {
			t.Fatalf("operation error = %v, want ErrInvalidSeed", err)
		}
	}
	if api.addCalls != 0 || api.copyCalls != 0 || api.updateCalls != 0 {
		t.Fatalf("invalid seeds reached keychain: add=%d copy=%d update=%d", api.addCalls, api.copyCalls, api.updateCalls)
	}
	if _, err := store.Read(ctx, layout.ConnectorInstance("../escape")); err == nil {
		t.Fatal("invalid instance reached keychain")
	}
	if api.copyCalls != 0 {
		t.Fatal("invalid instance reached keychain")
	}
}

func TestNamedInstancesHaveIndependentKeychainAccounts(t *testing.T) {
	api := newFakeSecItemAPI()
	store := newKeychainStore(api)
	if err := store.Create(context.Background(), "east", seedWith(0x61)); err != nil {
		t.Fatal(err)
	}
	if err := store.Create(context.Background(), "west", seedWith(0x62)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read(context.Background(), "east"); err != nil {
		t.Fatal(err)
	}
	if api.lastItem != (itemID{service: serviceName, account: "east"}) {
		t.Fatalf("east account query = %+v", api.lastItem)
	}
	if _, err := store.Read(context.Background(), "west"); err != nil {
		t.Fatal(err)
	}
	if api.lastItem != (itemID{service: serviceName, account: "west"}) {
		t.Fatalf("west account query = %+v", api.lastItem)
	}
	if api.items[itemID{service: serviceName, account: "east"}][0] != 0x61 || api.items[itemID{service: serviceName, account: "west"}][0] != 0x62 {
		t.Fatal("named instances shared a keychain item")
	}
}

func TestKeychainErrorsDoNotExposeSeedBytes(t *testing.T) {
	api := newFakeSecItemAPI()
	api.addStatus = secStatus(-25308)
	store := newKeychainStore(api)
	seed := seedWith(0x7a)
	err := store.Create(context.Background(), "blue", seed)
	if err == nil {
		t.Fatal("expected keychain error")
	}
	if strings.Contains(err.Error(), strings.Repeat("z", ed25519.SeedSize)) {
		t.Fatal("keychain error exposed the seed")
	}
}
