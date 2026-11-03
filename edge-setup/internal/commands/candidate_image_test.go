package commands

import (
	"bytes"
	"encoding/binary"
	"testing"

	"debug/macho"
)

const (
	machOHeader64Size = 32
	machOHeader32Size = 28
	machOCommandUUID  = 0x1b
	machOCommandSize  = 24
)

func machOImage64(cpu macho.Cpu, fileType macho.Type, ncmd, cmdsz uint32, order binary.ByteOrder, commands []byte) []byte {
	data := make([]byte, machOHeader64Size+len(commands))
	order.PutUint32(data[0:4], macho.Magic64)
	order.PutUint32(data[4:8], uint32(cpu))
	order.PutUint32(data[8:12], 0)
	order.PutUint32(data[12:16], uint32(fileType))
	order.PutUint32(data[16:20], ncmd)
	order.PutUint32(data[20:24], cmdsz)
	order.PutUint32(data[24:28], 0)
	order.PutUint32(data[28:32], 0)
	copy(data[machOHeader64Size:], commands)
	return data
}

func machOImage32(cpu macho.Cpu, fileType macho.Type, commands []byte) []byte {
	data := make([]byte, machOHeader32Size+len(commands))
	binary.LittleEndian.PutUint32(data[0:4], macho.Magic32)
	binary.LittleEndian.PutUint32(data[4:8], uint32(cpu))
	binary.LittleEndian.PutUint32(data[8:12], 0)
	binary.LittleEndian.PutUint32(data[12:16], uint32(fileType))
	binary.LittleEndian.PutUint32(data[16:20], 1)
	binary.LittleEndian.PutUint32(data[20:24], uint32(len(commands)))
	binary.LittleEndian.PutUint32(data[24:28], 0)
	copy(data[machOHeader32Size:], commands)
	return data
}

func machOLoadCommand(order binary.ByteOrder) []byte {
	command := make([]byte, machOCommandSize)
	order.PutUint32(command[0:4], machOCommandUUID)
	order.PutUint32(command[4:8], machOCommandSize)
	return command
}

func machOExecutable64(cpu macho.Cpu) []byte {
	commands := machOLoadCommand(binary.LittleEndian)
	return machOImage64(cpu, macho.TypeExec, 1, uint32(len(commands)), binary.LittleEndian, commands)
}

func fatMachO(cpu macho.Cpu) []byte {
	thin := machOExecutable64(cpu)
	const fatHeaderAndArchSize = 8 + 20
	data := make([]byte, fatHeaderAndArchSize+len(thin))
	binary.BigEndian.PutUint32(data[0:4], macho.MagicFat)
	binary.BigEndian.PutUint32(data[4:8], 1)
	binary.BigEndian.PutUint32(data[8:12], uint32(cpu))
	binary.BigEndian.PutUint32(data[12:16], 0)
	binary.BigEndian.PutUint32(data[16:20], fatHeaderAndArchSize)
	binary.BigEndian.PutUint32(data[20:24], uint32(len(thin)))
	binary.BigEndian.PutUint32(data[24:28], 0)
	copy(data[fatHeaderAndArchSize:], thin)
	return data
}

func TestValidateCandidateImageDarwinAcceptsExpectedThinExecutables(t *testing.T) {
	for _, tc := range []struct {
		name string
		arch string
		cpu  macho.Cpu
	}{
		{name: "amd64", arch: "amd64", cpu: macho.CpuAmd64},
		{name: "arm64", arch: "arm64", cpu: macho.CpuArm64},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateCandidateImage(machOExecutable64(tc.cpu), "darwin", tc.arch); err != nil {
				t.Fatalf("valid thin Mach-O rejected: %v", err)
			}
		})
	}
}

func TestValidateCandidateImageDarwinRejectsInvalidImages(t *testing.T) {
	validAMD64 := machOExecutable64(macho.CpuAmd64)
	validArm64 := machOExecutable64(macho.CpuArm64)
	bigEndianAMD64 := machOImage64(
		macho.CpuAmd64,
		macho.TypeExec,
		1,
		machOCommandSize,
		binary.BigEndian,
		machOLoadCommand(binary.BigEndian),
	)
	object := machOImage64(
		macho.CpuAmd64,
		macho.TypeObj,
		1,
		machOCommandSize,
		binary.LittleEndian,
		machOLoadCommand(binary.LittleEndian),
	)
	tooManyCommands := machOImage64(macho.CpuAmd64, macho.TypeExec, 4097, 4097*8, binary.LittleEndian, nil)
	tooMuchCommandData := machOImage64(macho.CpuAmd64, macho.TypeExec, 1, 1<<20+1, binary.LittleEndian, nil)
	tooFewCommandBytes := machOImage64(macho.CpuAmd64, macho.TypeExec, 2, 8, binary.LittleEndian, nil)
	commandRegionPastEOF := validAMD64[:machOHeader64Size+8]
	truncatedCommand := validAMD64[:len(validAMD64)-1]
	truncatedHeader := validAMD64[:machOHeader64Size-1]
	zeroCommands := machOImage64(macho.CpuAmd64, macho.TypeExec, 0, 0, binary.LittleEndian, nil)

	cases := []struct {
		name string
		data []byte
		arch string
	}{
		{name: "wrong CPU for amd64 target", data: validArm64, arch: "amd64"},
		{name: "wrong CPU for arm64 target", data: validAMD64, arch: "arm64"},
		{name: "big endian", data: bigEndianAMD64, arch: "amd64"},
		{name: "32 bit header", data: machOImage32(macho.CpuAmd64, macho.TypeExec, machOLoadCommand(binary.LittleEndian)[:8]), arch: "amd64"},
		{name: "object file", data: object, arch: "amd64"},
		{name: "fat binary", data: fatMachO(macho.CpuAmd64), arch: "amd64"},
		{name: "truncated magic", data: []byte{0xcf, 0xfa, 0xed}, arch: "amd64"},
		{name: "truncated header", data: truncatedHeader, arch: "amd64"},
		{name: "truncated command", data: truncatedCommand, arch: "amd64"},
		{name: "command region past EOF", data: commandRegionPastEOF, arch: "amd64"},
		{name: "zero commands", data: zeroCommands, arch: "amd64"},
		{name: "too many commands", data: tooManyCommands, arch: "amd64"},
		{name: "command data over limit", data: tooMuchCommandData, arch: "amd64"},
		{name: "command count exceeds minimum table capacity", data: tooFewCommandBytes, arch: "amd64"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateCandidateImage(tc.data, "darwin", tc.arch); err == nil {
				t.Fatal("invalid Mach-O candidate was accepted")
			}
		})
	}
}

func TestFatMachOFixtureIsUniversal(t *testing.T) {
	data := fatMachO(macho.CpuAmd64)
	if _, err := macho.NewFatFile(bytes.NewReader(data)); err != nil {
		t.Fatalf("fixture is not a valid fat Mach-O: %v", err)
	}
}

func TestValidateCandidateImageLinuxKeepsELFMagicCheck(t *testing.T) {
	if err := validateCandidateImage([]byte{0x7f, 'E', 'L', 'F'}, "linux", "amd64"); err != nil {
		t.Fatalf("ELF magic rejected: %v", err)
	}
	if err := validateCandidateImage([]byte("not ELF"), "linux", "amd64"); err == nil {
		t.Fatal("non-ELF candidate was accepted")
	}
}
