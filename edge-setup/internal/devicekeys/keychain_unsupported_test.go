//go:build !darwin

package devicekeys

import (
	"errors"
	"testing"
)

func TestNewReportsUnsupportedPlatform(t *testing.T) {
	store, err := New()
	if store != nil || !errors.Is(err, ErrUnsupported) {
		t.Fatalf("New() = (%v, %v), want (nil, ErrUnsupported)", store, err)
	}
}
