package commands

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

type labCrashReservation struct {
	lock  *os.File
	path  string
	owner fsx.Owner
}

// A reserved nonce is never replayed, including when interrupted after the
// signal but before health verification. Recovery observes systemd; it must
// not turn an ambiguous first fault into a second fault.
func reserveLabCrash(dir string, owner fsx.Owner, options labCrashOptions) (*labCrashReservation, error) {
	info, err := fsx.Lstat(dir)
	if err != nil || (info.Exists && (!info.Dir || info.Symlink || info.Owner != owner || info.Mode != 0o700)) {
		return nil, errors.New("the lab crash receipt directory is unsafe")
	}
	if !info.Exists {
		if err := fsx.EnsureDir(dir, 0o700, owner); err != nil {
			return nil, errors.New("the private lab receipt directory could not be prepared")
		}
	}
	lock, err := os.OpenFile(filepath.Join(dir, "lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, errors.New("another lab gateway fault is in progress")
	}
	reservation := &labCrashReservation{lock: lock, path: filepath.Join(dir, options.Nonce+".json"), owner: owner}
	file, err := os.OpenFile(reservation.path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		reservation.Close()
		return nil, errors.New("the lab fault nonce is already reserved or could not be reserved; no signal was sent")
	}
	body, _ := json.Marshal(map[string]string{"state": "reserved", "runtimeId": options.RuntimeID, "nonce": options.Nonce})
	_, writeErr := file.Write(body)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		reservation.Close()
		return nil, errors.New("the fault reservation could not be persisted; no signal was sent")
	}
	return reservation, nil
}

func (reservation *labCrashReservation) Complete(evidence *labCrashEvidence) error {
	body, err := json.Marshal(evidence)
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(reservation.path, body, 0o600, reservation.owner)
}

func (reservation *labCrashReservation) Close() {
	_ = syscall.Flock(int(reservation.lock.Fd()), syscall.LOCK_UN)
	_ = reservation.lock.Close()
}
