package commands

import (
	"bytes"
	"debug/macho"
	"encoding/binary"
	"errors"
)

// Authentication precedes format inspection. This checks the expected image
// format and CPU, not whether the native loader will accept the executable.
func validateCandidateImage(data []byte, goos, arch string) error {
	if goos == "linux" {
		if len(data) < len(elfMagic) || !bytes.Equal(data[:len(elfMagic)], elfMagic) {
			return errors.New("not an ELF executable")
		}
		return nil
	}
	bad := errors.New("not a thin Mach-O executable for this macOS architecture")
	if goos != "darwin" || len(data) < 32 {
		return bad
	}
	var cpu macho.Cpu
	switch arch {
	case "amd64":
		cpu = macho.CpuAmd64
	case "arm64":
		cpu = macho.CpuArm64
	default:
		return bad
	}
	order := binary.LittleEndian
	if order.Uint32(data[:4]) != macho.Magic64 || order.Uint32(data[4:8]) != uint32(cpu) || order.Uint32(data[12:16]) != uint32(macho.TypeExec) {
		return bad
	}
	ncmd, cmdsz := order.Uint32(data[16:20]), order.Uint32(data[20:24])
	if ncmd == 0 || ncmd > 4096 || cmdsz > 1<<20 || ncmd > cmdsz/8 || uint64(cmdsz) > uint64(len(data)-32) {
		return bad
	}
	image, err := macho.NewFile(bytes.NewReader(data))
	if err != nil {
		return bad
	}
	defer image.Close()
	if image.Magic != macho.Magic64 || image.Cpu != cpu || image.Type != macho.TypeExec || image.ByteOrder != binary.LittleEndian {
		return bad
	}
	return nil
}
