//go:build linux || darwin

package state

import (
	"os"
	"syscall"
	"testing"
)

func TestMain(m *testing.M) {
	// Permission fixtures require a predictable mask, set before any tests run.
	syscall.Umask(0o022)
	os.Exit(m.Run())
}
