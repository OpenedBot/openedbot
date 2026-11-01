package operator

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestListenAsUserServesBoundedHTTPOnPrivateSocket(t *testing.T) {
	path := filepath.Join(socketDir(t), "operator.sock")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		finished <- ListenAsUser(ctx, path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != "/ready" {
				http.NotFound(w, r)
				return
			}
			_, _ = io.WriteString(w, "ready")
		}))
	}()

	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 100 * time.Millisecond}).DialContext(ctx, "unix", path)
	}}
	client := &http.Client{Transport: transport, Timeout: 300 * time.Millisecond}
	deadline := time.Now().Add(2 * time.Second)
	var response *http.Response
	var err error
	for time.Now().Before(deadline) {
		response, err = client.Get("http://operator/ready")
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("bounded HTTP request over the temporary Unix socket failed: %v", err)
	}
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusOK || string(body) != "ready" {
		t.Fatalf("temporary socket response was not the expected bounded GET: status %d", response.StatusCode)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal("operator socket was not created")
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("operator socket mode = %04o, want 0600", got)
	}

	cancel()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("temporary operator listener stopped with an error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("temporary operator listener did not stop after cancellation")
	}
	transport.CloseIdleConnections()
}

func TestListenAsUserDoesNotUnlinkActiveSocket(t *testing.T) {
	path := filepath.Join(socketDir(t), "active.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal("could not create temporary active socket")
	}
	defer listener.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}

	err = ListenAsUser(context.Background(), path, http.NotFoundHandler())
	if err == nil {
		t.Fatal("a second operator listener was accepted")
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatal("refusing an active operator removed or changed its socket")
	}
	conn, err := net.DialTimeout("unix", path, 300*time.Millisecond)
	if err != nil {
		t.Fatal("the original socket stopped accepting connections after refusal")
	}
	_ = conn.Close()
}

func TestListenAsUserLeavesSymlinkAndRegularFileUntouched(t *testing.T) {
	dir := t.TempDir()
	regularPath := filepath.Join(dir, "operator.file")
	regularData := []byte("keep this file")
	if err := os.WriteFile(regularPath, regularData, 0o640); err != nil {
		t.Fatal(err)
	}
	linkTarget := filepath.Join(dir, "operator.file")
	symlinkPath := filepath.Join(dir, "operator.link")
	if err := os.Symlink(linkTarget, symlinkPath); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{regularPath, symlinkPath} {
		if err := ListenAsUser(context.Background(), path, http.NotFoundHandler()); err == nil {
			t.Fatalf("non-socket path %q was accepted", filepath.Base(path))
		}
	}

	data, err := os.ReadFile(regularPath)
	if err != nil || string(data) != string(regularData) {
		t.Fatal("regular file content changed after socket refusal")
	}
	info, err := os.Lstat(regularPath)
	if err != nil || info.Mode().Perm() != 0o640 || !info.Mode().IsRegular() {
		t.Fatal("regular file metadata changed after socket refusal")
	}
	gotTarget, err := os.Readlink(symlinkPath)
	if err != nil || gotTarget != linkTarget {
		t.Fatal("symlink target changed after socket refusal")
	}
	info, err = os.Lstat(symlinkPath)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symlink was removed after socket refusal")
	}
	if _, err := os.Stat(symlinkPath); err != nil {
		t.Fatal("symlink target was damaged after socket refusal")
	}
}

// socketDir is a short private directory: t.TempDir embeds the test name,
// and on macOS the result overflows the 104-byte sun_path of a Unix socket.
func socketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "op")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
