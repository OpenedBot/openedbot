package devicekeys

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

type resetAPICall struct {
	method  string
	service string
	account string
}

type fakeSecItemResetAPI struct {
	accountNames  []string
	accountStatus secStatus
	accountErr    error
	removeStatus  secStatus
	removeErr     error
	copyData      []byte
	copyStatus    secStatus
	copyErr       error
	onRemove      func()
	calls         []resetAPICall
}

func (f *fakeSecItemResetAPI) accounts(service string) ([]string, secStatus, error) {
	f.calls = append(f.calls, resetAPICall{method: "accounts", service: service})
	return append([]string(nil), f.accountNames...), f.accountStatus, f.accountErr
}

func (f *fakeSecItemResetAPI) remove(service, account string) (secStatus, error) {
	f.calls = append(f.calls, resetAPICall{method: "remove", service: service, account: account})
	if f.onRemove != nil {
		f.onRemove()
	}
	return f.removeStatus, f.removeErr
}

func (f *fakeSecItemResetAPI) copy(service, account string) ([]byte, secStatus, error) {
	f.calls = append(f.calls, resetAPICall{method: "copy", service: service, account: account})
	return f.copyData, f.copyStatus, f.copyErr
}

func TestResetStoreInstancesUsesDedicatedNamespaceAndReturnsSortedInstances(t *testing.T) {
	api := &fakeSecItemResetAPI{accountNames: []string{"zeta", "default", "alpha"}}
	store := newResetStore(api)

	got, err := store.Instances(context.Background())
	if err != nil {
		t.Fatalf("Instances() failed: %v", err)
	}
	want := []layout.ConnectorInstance{layout.DefaultConnectorInstance, "alpha", "zeta"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("Instances() = %q, want %q", got, want)
	}
	wantCalls := []resetAPICall{{method: "accounts", service: serviceName}}
	if fmt.Sprint(api.calls) != fmt.Sprint(wantCalls) {
		t.Fatalf("Keychain queries = %+v, want only fixed-service account enumeration %+v", api.calls, wantCalls)
	}
}

func TestResetStoreInstancesRejectsAmbiguousOrInvalidAccounts(t *testing.T) {
	secret := "bad_account_secret"
	tests := []struct {
		name     string
		accounts []string
	}{
		{name: "duplicate", accounts: []string{"alpha", "alpha"}},
		{name: "uppercase", accounts: []string{"Alpha"}},
		{name: "reserved", accounts: []string{"runs"}},
		{name: "non ASCII", accounts: []string{"café"}},
		{name: "raw invalid account value", accounts: []string{secret}},
		{name: "oversize", accounts: []string{strings.Repeat("a", 257)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := &fakeSecItemResetAPI{accountNames: tt.accounts}
			store := newResetStore(api)
			_, err := store.Instances(context.Background())
			if err == nil || strings.Contains(err.Error(), secret) {
				t.Fatalf("invalid inventory accepted or leaked a fixture value: %v", err)
			}
			if len(api.calls) != 1 || api.calls[0] != (resetAPICall{method: "accounts", service: serviceName}) {
				t.Fatalf("invalid inventory triggered extra Keychain calls: %+v", api.calls)
			}
		})
	}

	t.Run("inventory count over cap", func(t *testing.T) {
		accounts := make([]string, 257)
		for i := range accounts {
			accounts[i] = "alpha"
		}
		api := &fakeSecItemResetAPI{accountNames: accounts}
		_, err := newResetStore(api).Instances(context.Background())
		if err == nil || strings.Contains(err.Error(), secret) || len(api.calls) != 1 {
			t.Fatalf("oversize inventory was accepted, leaked, or queried repeatedly: %v, %+v", err, api.calls)
		}
	})
}

func TestResetStoreInstancesRequiresReadableUnambiguousStatus(t *testing.T) {
	secret := "accounts-transcript-secret"
	tests := []struct {
		name     string
		status   secStatus
		accounts []string
		err      error
	}{
		{name: "unknown status", status: secStatus(-25291), err: errors.New(secret)},
		{name: "not found with account", status: statusItemNotFound, accounts: []string{"alpha"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := &fakeSecItemResetAPI{accountNames: tt.accounts, accountStatus: tt.status, accountErr: tt.err}
			_, err := newResetStore(api).Instances(context.Background())
			if err == nil || strings.Contains(err.Error(), secret) {
				t.Fatalf("unverified inventory was accepted or leaked diagnostics: %v", err)
			}
			if len(api.calls) != 1 || api.calls[0].service != serviceName {
				t.Fatalf("unexpected Keychain calls: %+v", api.calls)
			}
		})
	}

	api := &fakeSecItemResetAPI{accountStatus: statusItemNotFound}
	got, err := newResetStore(api).Instances(context.Background())
	if err != nil || len(got) != 0 {
		t.Fatalf("verified empty inventory = %q, %v", got, err)
	}
}

func TestResetStoreRemoveIsScopedIdempotentAndVerifiesAbsence(t *testing.T) {
	tests := []struct {
		name         string
		instance     layout.ConnectorInstance
		account      string
		removeStatus secStatus
	}{
		{name: "named instance", instance: "alpha", account: "alpha", removeStatus: statusSuccess},
		{name: "default instance idempotent", instance: layout.DefaultConnectorInstance, account: "default", removeStatus: statusItemNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := &fakeSecItemResetAPI{
				removeStatus: tt.removeStatus,
				copyStatus:   statusItemNotFound,
			}
			store := newResetStore(api)
			if err := store.Remove(context.Background(), tt.instance); err != nil {
				t.Fatalf("Remove() failed: %v", err)
			}
			wantCalls := []resetAPICall{
				{method: "remove", service: serviceName, account: tt.account},
				{method: "copy", service: serviceName, account: tt.account},
			}
			if fmt.Sprint(api.calls) != fmt.Sprint(wantCalls) {
				t.Fatalf("Keychain calls = %+v, want exact remove and readback %+v", api.calls, wantCalls)
			}
		})
	}
}

func TestResetStoreRemoveRefusesInvalidInstancesBeforeKeychainCalls(t *testing.T) {
	for _, instance := range []layout.ConnectorInstance{"../alpha", "runs", "default", "Alpha", "café"} {
		t.Run(string(instance), func(t *testing.T) {
			api := &fakeSecItemResetAPI{}
			err := newResetStore(api).Remove(context.Background(), instance)
			if err == nil || len(api.calls) != 0 {
				t.Fatalf("invalid instance %q reached Keychain: err=%v calls=%+v", instance, err, api.calls)
			}
		})
	}
}

func TestResetStoreRemoveFailureIsGenericAndDoesNotReadBack(t *testing.T) {
	secret := "remove-transcript-secret"
	tests := []struct {
		name   string
		status secStatus
		err    error
	}{
		{name: "API error", status: statusSuccess, err: errors.New(secret)},
		{name: "unknown status", status: secStatus(-25291)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := &fakeSecItemResetAPI{removeStatus: tt.status, removeErr: tt.err}
			err := newResetStore(api).Remove(context.Background(), layout.ConnectorInstance("alpha"))
			if err == nil || strings.Contains(err.Error(), secret) {
				t.Fatalf("remove failure was not generic: %v", err)
			}
			if len(api.calls) != 1 || api.calls[0] != (resetAPICall{method: "remove", service: serviceName, account: "alpha"}) {
				t.Fatalf("failed remove was followed by another Keychain operation: %+v", api.calls)
			}
		})
	}
}

func TestResetStoreRemoveRequiresVerifiedReadbackAndWipesReturnedBytes(t *testing.T) {
	secret := "copy-transcript-secret"
	tests := []struct {
		name   string
		status secStatus
		err    error
	}{
		{name: "still present", status: statusSuccess},
		{name: "inaccessible", status: secStatus(-25291), err: errors.New(secret)},
		{name: "readback API error", status: statusItemNotFound, err: errors.New(secret)},
		{name: "not-found status with contradictory data", status: statusItemNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			readback := []byte(secret)
			api := &fakeSecItemResetAPI{
				removeStatus: statusSuccess,
				copyData:     readback,
				copyStatus:   tt.status,
				copyErr:      tt.err,
			}
			err := newResetStore(api).Remove(context.Background(), layout.ConnectorInstance("alpha"))
			if !errors.Is(err, ErrRemovalVerification) || strings.Contains(err.Error(), secret) {
				t.Fatalf("unverified removal was accepted or leaked diagnostics: %v", err)
			}
			if !allZero(readback) {
				t.Fatal("readback bytes were not wiped on verification failure")
			}
			if len(api.calls) != 2 || api.calls[1] != (resetAPICall{method: "copy", service: serviceName, account: "alpha"}) {
				t.Fatalf("unexpected verification calls: %+v", api.calls)
			}
		})
	}
}

func TestResetStoreHonorsCancellationWithoutCallingKeychain(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	api := &fakeSecItemResetAPI{}
	store := newResetStore(api)
	if _, err := store.Instances(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Instances() error = %v, want context cancellation", err)
	}
	if err := store.Remove(ctx, layout.ConnectorInstance("alpha")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Remove() error = %v, want context cancellation", err)
	}
	if len(api.calls) != 0 {
		t.Fatalf("canceled context reached Keychain: %+v", api.calls)
	}
}

func TestResetStoreChecksCancellationBetweenRemoveAndReadback(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	api := &fakeSecItemResetAPI{onRemove: cancel, copyStatus: statusItemNotFound}
	err := newResetStore(api).Remove(ctx, layout.ConnectorInstance("alpha"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Remove() error = %v, want cancellation before readback", err)
	}
	if len(api.calls) != 1 || api.calls[0] != (resetAPICall{method: "remove", service: serviceName, account: "alpha"}) {
		t.Fatalf("canceled readback performed unexpected Keychain calls: %+v", api.calls)
	}
}

func allZero(data []byte) bool {
	for _, b := range data {
		if b != 0 {
			return false
		}
	}
	return true
}
