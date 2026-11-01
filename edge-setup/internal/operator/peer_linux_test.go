//go:build linux

package operator

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// serveGuarded serves a tiny handler on a real Unix socket behind the peer
// guard, with the cgroup lookup replaced, and returns a client for it.
func serveGuarded(t *testing.T, policy PeerPolicy, cgroup string) *http.Client {
	t.Helper()
	dir, err := os.MkdirTemp("", "opeer")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "s.sock")
	raw, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	ln := &peerListener{Listener: raw, policy: policy, cgroup: cgroupOf(cgroup), logf: t.Logf}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "verb") })}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		},
	}}
}

func TestPeerGuardOnARealSocket(t *testing.T) {
	uid, gid := os.Getuid(), os.Getgid()
	if uid == 0 {
		t.Skip("root is always admitted; run as a regular user to exercise the uid check")
	}
	self := PeerPolicy{ServiceUID: uid, ServiceGID: gid, Units: []string{"hermes-connector"}}
	other := PeerPolicy{ServiceUID: uid + 1, ServiceGID: gid, Units: []string{"hermes-connector"}}
	cases := []struct {
		name   string
		policy PeerPolicy
		cgroup string
		ok     bool
	}{
		{"service user in the connector unit", self, connectorCgroup, true},
		{"service user in the gateway unit", self, gatewayCgroup, false},
		{"service user in its user manager", self, fakeUserUnit, false},
		{"uid that is not the service user", other, connectorCgroup, false},
	}
	for _, tc := range cases {
		client := serveGuarded(t, tc.policy, tc.cgroup)
		resp, err := client.Get("http://operator/capabilities")
		if tc.ok {
			if err != nil {
				t.Fatalf("%s: refused: %v", tc.name, err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if string(body) != "verb" {
				t.Fatalf("%s: body %q", tc.name, body)
			}
			continue
		}
		if err == nil {
			resp.Body.Close()
			t.Fatalf("%s: a refused peer got HTTP %d", tc.name, resp.StatusCode)
		}
		if !strings.Contains(err.Error(), "EOF") && !strings.Contains(err.Error(), "reset") && !strings.Contains(err.Error(), "broken pipe") {
			t.Logf("%s: refused with %v", tc.name, err)
		}
	}
}

func TestUnixPeerCredReadsTheKernelView(t *testing.T) {
	dir, err := os.MkdirTemp("", "opeer")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "s.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := net.Dial("unix", path)
		if err == nil {
			time.Sleep(200 * time.Millisecond)
			c.Close()
		}
	}()
	conn, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	cred, err := unixPeerCred(conn)
	if err != nil {
		t.Fatal(err)
	}
	if cred.UID != os.Getuid() || cred.GID != os.Getgid() || cred.PID != os.Getpid() {
		t.Fatalf("peer cred %+v, want uid %d gid %d pid %d", cred, os.Getuid(), os.Getgid(), os.Getpid())
	}
	body, err := procCgroup(cred.PID)
	if err != nil || len(body) == 0 {
		t.Fatalf("own cgroup unreadable: %v", err)
	}
}
