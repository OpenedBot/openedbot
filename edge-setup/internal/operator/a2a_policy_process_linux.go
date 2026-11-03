//go:build linux

package operator

import (
	"errors"
	"net"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"golang.org/x/sys/unix"
)

func verifyA2APolicyProcessPeer(conn *net.UnixConn, owner fsx.Owner) error {
	if conn == nil {
		return errors.New("missing A2A policy process connection")
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var credentials *unix.Ucred
	var socketErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, socketErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if socketErr != nil {
		return socketErr
	}
	if credentials == nil || int(credentials.Uid) != owner.UID || int(credentials.Gid) != owner.GID {
		return errors.New("A2A policy process peer credentials differ from owner")
	}
	return nil
}
