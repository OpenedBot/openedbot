//go:build darwin

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
	var credentials *unix.Xucred
	var socketErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, socketErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	}); err != nil {
		return err
	}
	if socketErr != nil {
		return socketErr
	}
	if credentials == nil || int(credentials.Uid) != owner.UID {
		return errors.New("A2A policy process peer UID differs from owner")
	}
	return nil
}
