package proxy

import (
	"os/user"
	"strconv"
)

// lookupIDs returns uid/gid of a local account, or -1/-1.
func lookupIDs(name string) (int, int) {
	u, err := user.Lookup(name)
	if err != nil {
		return -1, -1
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	return uid, gid
}
