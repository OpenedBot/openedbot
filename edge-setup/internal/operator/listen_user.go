package operator

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

// ListenAsUser serves the same named verbs through a private local socket.
// It refuses another live operator, regular files and symlinks at that path.
func ListenAsUser(ctx context.Context, path string, h http.Handler) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("operator socket requires a clean absolute path")
	}
	if err := fsx.EnsureDir(filepath.Dir(path), 0o700, fsx.Current()); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("operator socket path is not a socket")
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(stat.Uid) != os.Geteuid() {
			return errors.New("operator socket belongs to another user")
		}
		conn, dialErr := net.DialTimeout("unix", path, 300*time.Millisecond)
		if dialErr == nil {
			_ = conn.Close()
			return errors.New("an operator is already listening")
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) && !errors.Is(dialErr, os.ErrNotExist) {
			return fmt.Errorf("existing operator socket could not be checked: %w", dialErr)
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	defer ln.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-done:
			return
		case <-ctx.Done():
		}
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(stopCtx)
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
