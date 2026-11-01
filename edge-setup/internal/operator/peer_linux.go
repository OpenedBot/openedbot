//go:build linux

package operator

import (
	"errors"
	"net"
	"os"
	"strconv"
	"syscall"
)

// peerListener closes, before any byte is read, every accepted connection
// whose peer the policy refuses. net/http never sees a refused peer.
type peerListener struct {
	net.Listener
	policy PeerPolicy
	cgroup func(pid int) ([]byte, error)
	logf   func(string, ...any)
}

func (l *peerListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		cred, err := unixPeerCred(conn)
		if err == nil {
			err = l.policy.Allow(cred, l.cgroup)
		}
		if err == nil {
			return conn, nil
		}
		if l.logf != nil {
			l.logf("operator: connection refused (%v)", err)
		}
		_ = conn.Close()
	}
}

func unixPeerCred(conn net.Conn) (PeerCred, error) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return PeerCred{}, errors.New("not a unix connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return PeerCred{}, err
	}
	var cred *syscall.Ucred
	var sockErr error
	if err := raw.Control(func(fd uintptr) {
		cred, sockErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return PeerCred{}, err
	}
	if sockErr != nil {
		return PeerCred{}, sockErr
	}
	return PeerCred{PID: int(cred.Pid), UID: int(cred.Uid), GID: int(cred.Gid)}, nil
}

func procCgroup(pid int) ([]byte, error) {
	return os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
}

func guardPeers(ln net.Listener, policy PeerPolicy, logf func(string, ...any)) net.Listener {
	return &peerListener{Listener: ln, policy: policy, cgroup: procCgroup, logf: logf}
}
