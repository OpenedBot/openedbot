//go:build darwin

package operator

import (
	"context"
	"errors"
	"net"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

func proveA2ALoopbackListener(ctx context.Context, runner exec.Runner) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if runner == nil {
		return errors.New("cannot inspect local TCP listeners")
	}
	output, err := exec.Output(ctx, runner, "/usr/sbin/lsof", "-nP", "-F", "n", "-iTCP:9900", "-sTCP:LISTEN")
	if err != nil {
		return errors.New("cannot inspect local TCP listeners")
	}
	return parseLsofA2AListeners([]byte(output))
}

func parseLsofA2AListeners(body []byte) error {
	found := false
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "n") {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(line, "n"), " (LISTEN)")
		host, port, err := net.SplitHostPort(name)
		if err != nil {
			return errors.New("cannot parse local TCP listener address")
		}
		if port != strconv.Itoa(a2aCardPort) {
			continue
		}
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("A2A port is listening outside loopback")
		}
		found = true
	}
	if !found {
		return errors.New("A2A port has no listening socket")
	}
	return nil
}
