//go:build !linux

package operator

import "net"

// guardPeers is Linux only: the root operator socket exists on Linux only.
// The macOS operator runs as the user and listens through ListenAsUser.
func guardPeers(ln net.Listener, _ PeerPolicy, _ func(string, ...any)) net.Listener { return ln }
