//go:build !linux

package commands

// denyProcessIntrospection does nothing off Linux: PR_SET_DUMPABLE is a Linux
// prctl, and the macOS connector runs as the login user under launchd.
func denyProcessIntrospection() error { return nil }
