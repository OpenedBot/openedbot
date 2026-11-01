// Package proxy contains only the rollback compatibility needed to retire
// public reverse proxies created by pre connector-only releases.
package proxy

import "github.com/OpenedBot/openedbot/edge-setup/internal/fsx"

// ManagedMarker is the first line of a Caddyfile written by old releases.
const ManagedMarker = "# Managed by hermes-setup; do not edit."

func caddyOwner() fsx.Owner {
	uid, gid := lookupIDs("caddy")
	if uid < 0 {
		return fsx.Root
	}
	return fsx.Owner{UID: uid, GID: gid}
}
