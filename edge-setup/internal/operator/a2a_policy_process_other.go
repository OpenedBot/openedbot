//go:build !linux && !darwin

package operator

import (
	"errors"
	"net"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func verifyA2APolicyProcessPeer(_ *net.UnixConn, _ fsx.Owner) error {
	return errors.New("A2A policy process peer credentials are unsupported on this platform")
}
