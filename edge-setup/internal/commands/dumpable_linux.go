//go:build linux

package commands

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// denyProcessIntrospection marks this process non-dumpable (PR_SET_DUMPABLE=0).
//
// The connector runs as the gateway's uid, and the kernel lets a process open
// /proc/<pid>/{root,cwd,fd,environ,mem} of any dumpable process of its own uid.
// /proc/<pid>/root walks past the gateway's InaccessiblePaths= into the
// connector's own mount namespace, where the unsealed device key and the link
// token are; fd and mem hand out its open files and its memory. The gateway
// shares the host's process view (Hermes 0.22 proves its live gateway from
// it), so it can see this PID. A non-dumpable process refuses all of them to
// every uid but root, whatever the systemd version.
//
// The flag belongs to the process: execve resets it and no other process can
// raise it. It costs no core dump and root-only /proc/<pid>/{environ,fd,...};
// the connector reads none of its own, and relies on no core dump. It runs
// before any credential is read, so the few milliseconds between execve and
// this call are the only window left.
func denyProcessIntrospection() error {
	if err := unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0); err != nil {
		return fmt.Errorf("cannot mark the process non-dumpable: %w", err)
	}
	return nil
}
