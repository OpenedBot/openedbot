package operator

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// PeerCred is what the kernel says about the process on the other end of
// an accepted Unix connection (SO_PEERCRED), plus the cgroup that process
// lived in when the connection was checked.
type PeerCred struct {
	PID, UID, GID int
}

// PeerPolicy decides who may talk to the root operator. The socket mode
// (0660 root:hermes, in a 0750 directory) already keeps every other uid
// out; the policy is the second, independent gate. Root is always
// accepted (the installer, `doctor`, an administrator with sudo). The
// service user is accepted only from the connector's own system unit:
// the gateway, its agent tools, the rootless Docker daemon and anything a
// sandbox escape could start all run as that same uid, and none of them
// lives in the connector's cgroup, which only PID 1 can place a process in.
type PeerPolicy struct {
	ServiceUID, ServiceGID int
	// Units are the system unit names (without .service) whose processes
	// may connect as the service user. An instance of a template unit
	// matches its template name followed by "@".
	Units []string
}

var cgroupUnitRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_.\\-]*(@[A-Za-z0-9:_.\\-]+)?\.service$`)

var cgroupSliceRe = regexp.MustCompile(`^system-[A-Za-z0-9:_.\\-]+\.slice$`)

var errPeerRefused = errors.New("peer refused")

// Allow returns nil when cred may use the operator. cgroup is the raw
// content of /proc/<pid>/cgroup, read only for a non-root peer.
func (p PeerPolicy) Allow(cred PeerCred, cgroup func(pid int) ([]byte, error)) error {
	if cred.UID == 0 {
		return nil
	}
	if cred.UID != p.ServiceUID || cred.GID != p.ServiceGID || p.ServiceUID <= 0 {
		return fmt.Errorf("%w: uid %d gid %d", errPeerRefused, cred.UID, cred.GID)
	}
	if cred.PID <= 0 || cgroup == nil {
		return fmt.Errorf("%w: no peer pid", errPeerRefused)
	}
	// PID reuse window. SO_PEERCRED records the peer's pid at connect(), and
	// /proc/<pid>/cgroup is read afterwards: if the peer exits in between and
	// the kernel hands the same pid to a process of the connector unit, this
	// check reads the connector's cgroup for a connection that is not the
	// connector's. The uid and gid above cannot be spoofed that way (they are
	// the socket's credentials, fixed at connect), so the race only matters
	// for a peer that already runs as the hermes uid. To win it, that peer
	// would also have to exit and have a process it does not control (the
	// connector unit, which only PID 1 starts) take that exact pid, out of
	// pid_max, within the few syscalls between Accept and this read. It
	// would then reach only the operator's named verbs. The risk is low and
	// accepted; SO_PEERPIDFD (Linux 6.5+) would close it and is the way to go
	// once every supported distribution kernel has it.
	raw, err := cgroup(cred.PID)
	if err != nil {
		return fmt.Errorf("%w: cgroup of pid %d unreadable", errPeerRefused, cred.PID)
	}
	unit, ok := systemUnitOf(raw)
	if !ok {
		return fmt.Errorf("%w: pid %d is not in a system service", errPeerRefused, cred.PID)
	}
	for _, want := range p.Units {
		if unit == want+".service" || (strings.HasSuffix(want, "@") && strings.HasPrefix(unit, want) && strings.HasSuffix(unit, ".service")) {
			return nil
		}
	}
	return fmt.Errorf("%w: pid %d runs in %s", errPeerRefused, cred.PID, unit)
}

// systemUnitOf returns the system service a process belongs to, from its
// /proc/<pid>/cgroup. The unified (cgroup v2) line wins; a v1 host is read
// through the name=systemd hierarchy. Only a unit of the system manager
// counts: directly under /system.slice, or in the per-template slice PID 1
// creates for instances (/system.slice/system-hermes\x2dconnector.slice/
// hermes-connector@NAME.service). A user manager (user.slice/user@UID.service/...)
// can name its own units anything, including the connector's name.
func systemUnitOf(raw []byte) (string, bool) {
	var unified, named string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		switch {
		case parts[0] == "0" && parts[1] == "":
			unified = parts[2]
		case parts[1] == "name=systemd":
			named = parts[2]
		}
	}
	path := unified
	if path == "" {
		path = named
	}
	rest, ok := strings.CutPrefix(path, "/system.slice/")
	if !ok {
		return "", false
	}
	unit, below, _ := strings.Cut(rest, "/")
	if cgroupSliceRe.MatchString(unit) {
		unit, _, _ = strings.Cut(below, "/")
	}
	if !cgroupUnitRe.MatchString(unit) {
		return "", false
	}
	return unit, true
}
