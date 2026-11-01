package devicekeys

import (
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeUserInteractionPolicy struct {
	mu        sync.Mutex
	allowed   bool
	getErr    error
	setErrors map[bool][]error
	calls     []string
}

func (f *fakeUserInteractionPolicy) getUserInteractionAllowed() (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "get")
	return f.allowed, f.getErr
}

func (f *fakeUserInteractionPolicy) setUserInteractionAllowed(allowed bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "set:"+strconvBool(allowed))
	if queued := f.setErrors[allowed]; len(queued) > 0 {
		err := queued[0]
		f.setErrors[allowed] = queued[1:]
		if err != nil {
			return err
		}
	}
	f.allowed = allowed
	return nil
}

func (f *fakeUserInteractionPolicy) record(name string) {
	f.mu.Lock()
	f.calls = append(f.calls, name)
	f.mu.Unlock()
}

func (f *fakeUserInteractionPolicy) snapshot() ([]string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...), f.allowed
}

func strconvBool(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func TestInteractionScopeOrdersAndRestoresPolicy(t *testing.T) {
	policy := &fakeUserInteractionPolicy{allowed: true}
	value, err := withUserInteractionDisabled[int](policy, func() (int, error) {
		policy.record("operation")
		return 17, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if value != 17 {
		t.Fatalf("operation result = %d, want 17", value)
	}
	calls, allowed := policy.snapshot()
	if !reflect.DeepEqual(calls, []string{"get", "set:false", "operation", "set:true"}) {
		t.Fatalf("policy call order = %v", calls)
	}
	if !allowed {
		t.Fatal("previously allowed interaction policy was not restored")
	}
}

func TestInteractionScopeRestoresAfterOperationError(t *testing.T) {
	policy := &fakeUserInteractionPolicy{allowed: false}
	opErr := errors.New("SecItem failed")
	secret := []byte(strings.Repeat("s", 32))
	got, err := withUserInteractionDisabled[[]byte](policy, func() ([]byte, error) {
		policy.record("operation")
		return secret, opErr
	}, wipe)
	if !errors.Is(err, opErr) {
		t.Fatalf("scope error = %v, want operation error", err)
	}
	if got != nil {
		t.Fatalf("failed operation returned data %q", got)
	}
	for _, value := range secret {
		if value != 0 {
			t.Fatal("failed operation result was not wiped")
		}
	}
	calls, allowed := policy.snapshot()
	if !reflect.DeepEqual(calls, []string{"get", "set:false", "operation", "set:false"}) {
		t.Fatalf("policy call order = %v", calls)
	}
	if allowed {
		t.Fatal("previously disabled interaction policy was changed")
	}
}

func TestInteractionScopeAttemptsRestoreAfterDisableFailure(t *testing.T) {
	policy := &fakeUserInteractionPolicy{
		allowed:   true,
		setErrors: map[bool][]error{false: {errors.New("disable failed")}},
	}
	called := false
	_, err := withUserInteractionDisabled[int](policy, func() (int, error) {
		called = true
		return 1, nil
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "disable keychain user interaction") {
		t.Fatalf("scope error = %v, want disable error", err)
	}
	if called {
		t.Fatal("operation ran after interaction suppression failed")
	}
	calls, allowed := policy.snapshot()
	if !reflect.DeepEqual(calls, []string{"get", "set:false", "set:true"}) {
		t.Fatalf("policy call order = %v", calls)
	}
	if !allowed {
		t.Fatal("previous policy was not restored after disable failure")
	}
}

func TestInteractionRestoreFailurePropagatesAndWipesSeed(t *testing.T) {
	policy := &fakeUserInteractionPolicy{
		allowed:   true,
		setErrors: map[bool][]error{true: {errors.New("restore failed")}},
	}
	secret := []byte(strings.Repeat("k", 32))
	got, err := withUserInteractionDisabled[[]byte](policy, func() ([]byte, error) {
		policy.record("operation")
		return secret, nil
	}, wipe)
	if err == nil || !strings.Contains(err.Error(), "restore keychain user interaction policy") {
		t.Fatalf("scope error = %v, want restore error", err)
	}
	if got != nil {
		t.Fatalf("seed returned after restore failure: %q", got)
	}
	for _, value := range secret {
		if value != 0 {
			t.Fatal("seed was not wiped after restore failure")
		}
	}
}

func TestInteractionScopeSerializesConcurrentOperations(t *testing.T) {
	policy := &fakeUserInteractionPolicy{allowed: true}
	var mu sync.Mutex
	active := 0
	maxActive := 0
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := withUserInteractionDisabled[int](policy, func() (int, error) {
				policy.record("operation")
				mu.Lock()
				active++
				if active > maxActive {
					maxActive = active
				}
				mu.Unlock()
				time.Sleep(10 * time.Millisecond)
				mu.Lock()
				active--
				mu.Unlock()
				return 1, nil
			}, nil)
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if maxActive != 1 {
		t.Fatalf("maximum overlapping keychain operations = %d, want 1", maxActive)
	}
	_, allowed := policy.snapshot()
	if !allowed {
		t.Fatal("interaction policy was not restored after concurrent operations")
	}
}
