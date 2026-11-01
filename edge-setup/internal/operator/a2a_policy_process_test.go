package operator

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const validA2APolicyProcessSnapshot = `{"schema":1,"generation":"generation_123456789","peerNames":["alpha","zeta"],"trustedPeers":["alpha","zeta"],"peerTokensOverride":false,"trustedPeersOverride":false,"allowAllUsers":false,"localhostOnly":false,"policyGuard":true}`

func TestDecodeA2APolicyProcessSnapshot(t *testing.T) {
	state, err := decodeA2APolicyProcessSnapshot([]byte(validA2APolicyProcessSnapshot))
	if err != nil {
		t.Fatalf("valid snapshot rejected: %v", err)
	}
	if !state.Known || !state.Running || state.Generation != "generation_123456789" ||
		!equalStrings(state.PeerNames, []string{"alpha", "zeta"}) ||
		!equalStrings(state.TrustedPeers, []string{"alpha", "zeta"}) || state.LocalhostOnly {
		t.Fatalf("valid snapshot was not projected as expected")
	}

	localhostOnly := strings.Replace(validA2APolicyProcessSnapshot,
		`"peerNames":["alpha","zeta"],"trustedPeers":["alpha","zeta"]`,
		`"peerNames":[],"trustedPeers":[]`, 1)
	localhostOnly = strings.Replace(localhostOnly, `"localhostOnly":false`, `"localhostOnly":true`, 1)
	state, err = decodeA2APolicyProcessSnapshot([]byte(localhostOnly))
	if err != nil || !state.LocalhostOnly || len(state.PeerNames) != 0 {
		t.Fatalf("valid tokenless localhost-only snapshot rejected")
	}
}

func TestDecodeA2APolicyProcessSnapshotRejectsInvalidMetadata(t *testing.T) {
	tooMany := make([]string, maxA2APolicyPeers+1)
	for index := range tooMany {
		tooMany[index] = fmt.Sprintf(`"peer-%02d"`, index)
	}
	tooManyNames := strings.Replace(validA2APolicyProcessSnapshot,
		`"peerNames":["alpha","zeta"]`, `"peerNames":[`+strings.Join(tooMany, ",")+`]`, 1)
	cases := []struct {
		name string
		body string
	}{
		{name: "duplicate key", body: strings.Replace(validA2APolicyProcessSnapshot, `"schema":1`, `"schema":1,"schema":1`, 1)},
		{name: "unknown token field", body: strings.TrimSuffix(validA2APolicyProcessSnapshot, "}") + `,"tokenValue":"omitted"}`},
		{name: "trailing object", body: validA2APolicyProcessSnapshot + ` {}`},
		{name: "oversized", body: strings.Repeat("x", maxA2APolicyOutput+1)},
		{name: "wrong schema", body: strings.Replace(validA2APolicyProcessSnapshot, `"schema":1`, `"schema":2`, 1)},
		{name: "bad generation", body: strings.Replace(validA2APolicyProcessSnapshot, `generation_123456789`, `../bad`, 1)},
		{name: "missing localhost mode", body: strings.Replace(validA2APolicyProcessSnapshot, `,"localhostOnly":false`, "", 1)},
		{name: "unguarded", body: strings.Replace(validA2APolicyProcessSnapshot, `"policyGuard":true`, `"policyGuard":false`, 1)},
		{name: "unsorted peer names", body: strings.Replace(validA2APolicyProcessSnapshot, `"peerNames":["alpha","zeta"]`, `"peerNames":["zeta","alpha"]`, 1)},
		{name: "duplicate trusted peer", body: strings.Replace(validA2APolicyProcessSnapshot, `"trustedPeers":["alpha","zeta"]`, `"trustedPeers":["alpha","alpha"]`, 1)},
		{name: "too many peer names", body: tooManyNames},
		{name: "localhost-only with token peers", body: strings.Replace(validA2APolicyProcessSnapshot, `"localhostOnly":false`, `"localhostOnly":true`, 1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := decodeA2APolicyProcessSnapshot([]byte(tc.body)); err == nil {
				t.Fatal("invalid snapshot accepted")
			}
		})
	}
}

func TestObserveA2APolicyProcessUsesFixedPrivateSocket(t *testing.T) {
	root := newA2APolicyProcessTestRoot(t)
	listener, socketPath := listenA2APolicyProcessTestSocket(t, root)
	serverErr := make(chan error, 1)
	go func() {
		conn, err := listener.AcceptUnix()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()
		request, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			serverErr <- err
			return
		}
		if !bytes.Equal(request, a2aPolicySnapshotRequest) {
			serverErr <- errors.New("unexpected fixed request")
			return
		}
		_, err = conn.Write([]byte(validA2APolicyProcessSnapshot))
		serverErr <- err
	}()

	observer := observeA2APolicyProcess(root, fsx.Current())
	state, err := observer(context.Background())
	if err != nil {
		t.Fatalf("observer rejected valid local snapshot: %v", err)
	}
	if !state.Known || !state.Running || len(state.PeerNames) != 2 || state.Generation == "" {
		t.Fatal("observer returned incomplete process state")
	}
	select {
	case err := <-serverErr:
		if err != nil {
			t.Fatalf("test socket exchange failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("test socket exchange did not finish")
	}
	if filepath.Base(socketPath) != a2aPolicyProcessSock {
		t.Fatal("observer did not use the fixed socket name")
	}
}

func TestObserveA2APolicyProcessHonorsParentCancellation(t *testing.T) {
	root := newA2APolicyProcessTestRoot(t)
	listener, _ := listenA2APolicyProcessTestSocket(t, root)
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		conn, err := listener.AcceptUnix()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = bufio.NewReader(conn).ReadBytes('\n')
		timer := time.NewTimer(250 * time.Millisecond)
		defer timer.Stop()
		<-timer.C
		_, _ = conn.Write([]byte(validA2APolicyProcessSnapshot))
	}()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(15 * time.Millisecond)
		cancel()
	}()
	started := time.Now()
	_, err := observeA2APolicyProcess(root, fsx.Current())(ctx)
	if err == nil || time.Since(started) > 150*time.Millisecond {
		t.Fatal("observer did not promptly honor context cancellation")
	}
	select {
	case <-serverDone:
	case <-time.After(time.Second):
		t.Fatal("cancelled socket server did not finish")
	}
}

func TestCheckedA2APolicyProcessSocketRejectsUnsafePaths(t *testing.T) {
	t.Run("symlink runtime root", func(t *testing.T) {
		target := newA2APolicyProcessTestRoot(t)
		rootLink := filepath.Join(newA2APolicyProcessTestRoot(t), "root-link")
		if err := os.Symlink(target, rootLink); err != nil {
			t.Fatal(err)
		}
		if _, err := checkedA2APolicyProcessSocket(rootLink, fsx.Current()); err == nil {
			t.Fatal("symlink runtime root accepted")
		}
	})

	t.Run("directory mode", func(t *testing.T) {
		root := newA2APolicyProcessTestRoot(t)
		listener, _ := listenA2APolicyProcessTestSocket(t, root)
		defer listener.Close()
		dir := filepath.Join(root, a2aPolicyProcessDirName)
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := checkedA2APolicyProcessSocket(root, fsx.Current()); err == nil {
			t.Fatal("non-private process directory accepted")
		}
	})

	t.Run("symlink process directory", func(t *testing.T) {
		root := newA2APolicyProcessTestRoot(t)
		listener, _ := listenA2APolicyProcessTestSocket(t, root)
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(root, a2aPolicyProcessDirName)
		moved := filepath.Join(root, "real-policy-dir")
		if err := os.Rename(dir, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(moved, dir); err != nil {
			t.Fatal(err)
		}
		if _, err := checkedA2APolicyProcessSocket(root, fsx.Current()); err == nil {
			t.Fatal("symlink process directory accepted")
		}
	})

	t.Run("socket mode", func(t *testing.T) {
		root := newA2APolicyProcessTestRoot(t)
		listener, socketPath := listenA2APolicyProcessTestSocket(t, root)
		defer listener.Close()
		if err := os.Chmod(socketPath, 0o640); err != nil {
			t.Fatal(err)
		}
		if _, err := checkedA2APolicyProcessSocket(root, fsx.Current()); err == nil {
			t.Fatal("non-private process socket accepted")
		}
	})

	t.Run("regular file at socket path", func(t *testing.T) {
		root := newA2APolicyProcessTestRoot(t)
		listener, socketPath := listenA2APolicyProcessTestSocket(t, root)
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(socketPath, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := checkedA2APolicyProcessSocket(root, fsx.Current()); err == nil {
			t.Fatal("regular file at socket path accepted")
		}
	})

	t.Run("symlink at socket path", func(t *testing.T) {
		root := newA2APolicyProcessTestRoot(t)
		listener, socketPath := listenA2APolicyProcessTestSocket(t, root)
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(root, "missing-target"), socketPath); err != nil {
			t.Fatal(err)
		}
		if _, err := checkedA2APolicyProcessSocket(root, fsx.Current()); err == nil {
			t.Fatal("symlink at socket path accepted")
		}
	})
}

func TestVerifyA2APolicyProcessPeerRejectsDifferentUID(t *testing.T) {
	root := newA2APolicyProcessTestRoot(t)
	listener, socketPath := listenA2APolicyProcessTestSocket(t, root)
	defer listener.Close()
	accepted := make(chan *net.UnixConn, 1)
	acceptErr := make(chan error, 1)
	go func() {
		conn, err := listener.AcceptUnix()
		if err != nil {
			acceptErr <- err
			return
		}
		accepted <- conn
	}()
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var peer *net.UnixConn
	select {
	case peer = <-accepted:
		defer peer.Close()
	case err := <-acceptErr:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("listener did not accept local connection")
	}
	owner := fsx.Current()
	owner.UID++
	if err := verifyA2APolicyProcessPeer(peer, owner); err == nil {
		t.Fatal("peer with a different expected UID was accepted")
	}
}

func listenA2APolicyProcessTestSocket(t *testing.T, runtimeRoot string) (*net.UnixListener, string) {
	t.Helper()
	stateDir := filepath.Join(runtimeRoot, a2aPolicyProcessDirName)
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(stateDir, a2aPolicyProcessSock)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener, socketPath
}

func newA2APolicyProcessTestRoot(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp("", "a2p-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}
