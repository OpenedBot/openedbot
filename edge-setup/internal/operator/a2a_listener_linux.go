//go:build linux

package operator

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

func proveA2ALoopbackListener(ctx context.Context, _ exec.Runner) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	found := false
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		body, err := os.ReadFile(path)
		if err != nil {
			return errors.New("cannot inspect local TCP listeners")
		}
		matched, err := parseProcA2AListeners(body)
		if err != nil {
			return err
		}
		found = found || matched
	}
	if !found {
		return errors.New("A2A port has no listening socket")
	}
	return nil
}

func parseProcA2AListeners(body []byte) (bool, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(body)))
	headerSeen := false
	found := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == "sl" {
			headerSeen = true
			continue
		}
		if !headerSeen || len(fields) < 4 {
			return false, errors.New("cannot parse local TCP listener table")
		}
		local := strings.Split(fields[1], ":")
		if len(local) != 2 {
			return false, errors.New("cannot parse local TCP listener address")
		}
		port, err := strconv.ParseUint(local[1], 16, 16)
		if err != nil {
			return false, errors.New("cannot parse local TCP listener port")
		}
		if port != a2aCardPort || strings.ToUpper(fields[3]) != "0A" {
			continue
		}
		ip, err := decodeProcAddress(local[0])
		if err != nil {
			return false, err
		}
		if !ip.IsLoopback() {
			return false, errors.New("A2A port is listening outside loopback")
		}
		found = true
	}
	if err := scanner.Err(); err != nil {
		return false, errors.New("cannot read local TCP listener table")
	}
	if !headerSeen {
		return false, errors.New("local TCP listener table is missing its header")
	}
	return found, nil
}

func decodeProcAddress(raw string) (net.IP, error) {
	decoded, err := hex.DecodeString(raw)
	if err != nil {
		return nil, errors.New("cannot decode local TCP listener address")
	}
	switch len(decoded) {
	case net.IPv4len:
		for left, right := 0, len(decoded)-1; left < right; left, right = left+1, right-1 {
			decoded[left], decoded[right] = decoded[right], decoded[left]
		}
	case net.IPv6len:
		// procfs prints each native-endian 32-bit word in host byte order.
		for start := 0; start < len(decoded); start += 4 {
			for left, right := start, start+3; left < right; left, right = left+1, right-1 {
				decoded[left], decoded[right] = decoded[right], decoded[left]
			}
		}
	default:
		return nil, errors.New("local TCP listener address has an unexpected size")
	}
	return net.IP(decoded), nil
}
