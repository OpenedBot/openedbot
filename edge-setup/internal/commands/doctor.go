package commands

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// doctor checks the running runtime and returns the problems found. It is
// read-only and reads the bearer only to present it to the loopback.
func doctor(ctx context.Context) ([]string, []string) {
	var problems, warnings []string
	sd := systemd.Client{Runner: runner}
	if active, _ := sd.IsActive(ctx, layout.GatewayUnit); !active {
		problems = append(problems, layout.GatewayUnit+".service is not active")
	}
	c := gateway.Loopback("")
	if st, err := c.Health(ctx); err != nil || (st != 200 && st != 401 && st != 403) {
		problems = append(problems, fmt.Sprintf("loopback /health: %v (HTTP %d)", err, st))
	}
	if ss, err := exec.Output(ctx, runner, "/usr/bin/ss", "-H", "-ltn"); err == nil {
		if hardening.PublicListener(ss, layout.GatewayPort) {
			problems = append(problems, fmt.Sprintf("Hermes listens publicly on :%d", layout.GatewayPort))
		}
		if !hardening.LoopbackListener(ss, layout.GatewayPort) {
			problems = append(problems, fmt.Sprintf("no loopback listener on :%d", layout.GatewayPort))
		}
	} else {
		problems = append(problems, "ss: "+err.Error())
	}
	if !multiplexProfilesConfigured(ctx, runner) {
		problems = append(problems, "gateway.multiplex_profiles = true is not configured")
	}
	if st, _ := state.Load(); st != nil && st.Features.Firewall {
		if problem := loopbackGuardProblem(ctx, runner, uidOf(ctx)); problem != "" {
			problems = append(problems, problem)
		}
	}
	token, err := hermes.Token()
	if err != nil {
		problems = append(problems, err.Error())
		return problems, warnings
	}
	c = gateway.Loopback(token)
	if err := c.RequireUnauthorizedWithoutBearer(ctx); err != nil {
		problems = append(problems, err.Error())
	}
	names, err := c.Toolsets(ctx)
	if err != nil {
		problems = append(problems, err.Error())
	} else if err := gateway.RequireToolsetPolicy(names); err != nil {
		problems = append(problems, err.Error())
	}
	st, _ := state.Load()
	if warning := gatewayUnitWarning(ctx, account.New(runner), st, layout.GatewayUnitPath, layout.ResolvConf); warning != "" {
		warnings = append(warnings, warning)
	}
	if st != nil && st.DockerEnabled {
		res, err := runner.Run(ctx, exec.Cmd{Path: "/usr/sbin/runuser", Args: []string{"-u", layout.ServiceUser, "--", "/usr/bin/env", "DOCKER_HOST=unix:///run/user/" + fmt.Sprint(uidOf(ctx)) + "/docker.sock", "docker", "info", "--format", "{{.SecurityOptions}}"}, Timeout: 30 * time.Second})
		if err != nil || res.ExitCode != 0 {
			problems = append(problems, "rootless docker of "+layout.ServiceUser+" does not answer")
		}
	}
	if st != nil {
		for _, inst := range connectorInstances() {
			// A refused link keeps its unit active (slow retries): the marker
			// is read first.
			if problem := linkRefusalProblem(inst); problem != "" && fsx.Exists(linkPathOf(inst)) {
				problems = append(problems, problem)
				continue
			}
			if active, _ := sd.IsActive(ctx, inst.Unit()); active {
				continue
			}
			if fsx.Exists(linkPathOf(inst)) {
				problems = append(problems, inst.Unit()+".service is not active although a link exists")
			} else if inst.IsDefault() {
				warnings = append(warnings, "connector mode without a link yet: run `edge-setup link --ohb https://… --yes` and paste the ticket at the hidden prompt")
			}
		}
		if problem, warning := autoUpgradeDoctor(loadAutoUpgradeRecord(layout.AutoUpgradeRecord)); problem != "" {
			problems = append(problems, problem)
		} else if warning != "" {
			warnings = append(warnings, warning)
		}
		if warning := autoUpgradeOffWarning(readAutoUpgradeSummary(ctx, sd)); warning != "" {
			warnings = append(warnings, warning)
		}
		if active, _ := sd.IsActive(ctx, layout.OperatorUnit); !active {
			problems = append(problems, layout.OperatorUnit+".service is not active: provider credentials cannot be posed from openedbot (run `up` again)")
		} else if !fsx.Exists(layout.OperatorSocket) {
			problems = append(problems, layout.OperatorSocket+" is missing although "+layout.OperatorUnit+" is active")
		}
	}
	return problems, warnings
}

// gatewayUnitWarning says, in one line, when the gateway unit installed at
// unitPath is not the one this binary renders for this host (the text `up`
// writes). It is empty when they match, and when that cannot be told: a unit
// that is missing is already reported as not active, and a parameter that
// cannot be derived (hermes.DesiredGatewayUnit) is `audit`'s UNKNOWN, not a
// warning here.
func gatewayUnitWarning(ctx context.Context, accounts account.Client, st *state.File, unitPath, resolvConf string) string {
	installed, err := os.ReadFile(unitPath)
	if err != nil {
		return ""
	}
	want, err := hermes.DesiredGatewayUnit(ctx, accounts, st, resolvConf, nil)
	if err != nil || string(installed) == want {
		return ""
	}
	return hermes.GatewayUnitStale
}

func multiplexProfilesConfigured(ctx context.Context, r exec.Runner) bool {
	result, err := r.Run(ctx, hermes.CLI("config", "get", "gateway.multiplex_profiles"))
	if err != nil {
		return false
	}
	if result.ExitCode == 0 {
		return strings.EqualFold(strings.TrimSpace(result.Stdout), "true")
	}
	// Hermes 0.22 keeps multiplexing enabled by default while the persisted
	// key is being retired. A missing-key response is therefore a valid proof
	// of the default, but an unrelated CLI failure is still a doctor problem.
	message := strings.ToLower(result.Stderr + "\n" + result.Stdout)
	for _, marker := range []string{"unknown config key", "config key not found", "key not found", "does not exist", "no such key"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func uidOf(ctx context.Context) int {
	out, err := exec.Output(ctx, runner, "/usr/bin/id", "-u", layout.ServiceUser)
	if err != nil {
		return 0
	}
	var uid int
	fmt.Sscan(out, &uid)
	return uid
}

// loopbackGuardProblem reads `iptables -S OUTPUT` and says, in one line, when
// the private loopback ports are not reserved for root and the service user.
// A host that cannot even list its rules is reported as such, never as fine.
func loopbackGuardProblem(ctx context.Context, r exec.Runner, serviceUID int) string {
	out, err := exec.Output(ctx, r, "/usr/sbin/iptables", "-w", "-S", "OUTPUT")
	if err != nil {
		return "iptables -S OUTPUT: " + err.Error()
	}
	if !hardening.IptablesLoopbackGuarded(out, []int{0, serviceUID}, hardening.LoopbackGuardPorts) {
		return fmt.Sprintf("loopback ports %v are not reserved for root and %s (%s.service missing or inactive: run `up` again)", hardening.LoopbackGuardPorts, layout.ServiceUser, layout.LoopbackGuardUnit)
	}
	return ""
}
