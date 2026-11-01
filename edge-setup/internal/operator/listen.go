package operator

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/user"
	"strconv"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// Listen creates the socket at path, readable and writable by root and the
// connector group only, and serves h until ctx ends.
func Listen(ctx context.Context, path string, h http.Handler) error {
	gid, mode := SocketOwnership(connectorGID())
	dir := layout.OperatorRunDir
	if err := fsx.EnsureDir(dir, 0o750, fsx.Owner{UID: 0, GID: gid}); err != nil {
		return err
	}
	if err := os.Chown(dir, 0, gid); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o750); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	if err := os.Chown(path, 0, gid); err != nil {
		ln.Close()
		return err
	}
	if err := os.Chmod(path, mode); err != nil {
		ln.Close()
		return err
	}
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	err = srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// SocketOwnership decides who may open the connector-only Unix socket.
func SocketOwnership(gid int, err error) (int, os.FileMode) {
	if err != nil {
		return 0, 0o600
	}
	return gid, 0o660
}

func connectorGID() (int, error) {
	g, err := user.LookupGroup(layout.ConnectorUser)
	if err != nil {
		return 0, fmt.Errorf("group %s: %w", layout.ConnectorUser, err)
	}
	gid, err := strconv.Atoi(g.Gid)
	if err != nil {
		return 0, err
	}
	return gid, nil
}
