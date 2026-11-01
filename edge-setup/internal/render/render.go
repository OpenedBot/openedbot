// Package render produces every file edge-setup writes on the host from
// embedded templates and the fixed layout. Rendering is pure: no I/O, no
// host facts other than the parameters passed in. Golden tests freeze the
// exact output.
package render

import (
	"bytes"
	"embed"
	"fmt"
	"net/netip"
	"text/template"

	"github.com/OpenedBot/openedbot/edge-setup/internal/egress"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

//go:embed all:templates
var files embed.FS

var templates = template.Must(template.New("").ParseFS(files, "templates/*.tmpl"))

func render(name string, data any) (string, error) {
	var buf bytes.Buffer
	if err := templates.ExecuteTemplate(&buf, name, data); err != nil {
		return "", fmt.Errorf("render %s: %w", name, err)
	}
	return buf.String(), nil
}

// resolverPrefixes renders the resolver exceptions as IPAddressAllow= values:
// one host prefix per address, nothing broader. An allow entry outranks the
// deny list (systemd.resource-control(5)), so an address that is not a plain
// address of a denied range is a caller bug and is refused rather than
// written into a unit.
func resolverPrefixes(resolvers []netip.Addr) ([]string, error) {
	out := make([]string, 0, len(resolvers))
	for _, addr := range resolvers {
		if !egress.Denied(addr) {
			return nil, fmt.Errorf("render: %v is not a plain address inside a denied range, it cannot be allowed", addr)
		}
		out = append(out, netip.PrefixFrom(addr, addr.BitLen()).String())
	}
	return out, nil
}

// GatewayParams selects the gateway unit variant.
type GatewayParams struct {
	// DockerEnabled points the docker CLI at the service user's rootless
	// daemon. False keeps the runtime's native backend under the confined
	// unprivileged gateway unit.
	DockerEnabled bool
	// UID of the service user, needed for /run/user/<uid>.
	UID int
	// EgressAllow are the host's resolvers that sit inside a denied range
	// (egress.ResolverAllow). Each is allowed alone, as a single host, so name
	// resolution survives the metadata deny. Empty when every resolver lies
	// elsewhere, which renders the unit as if the field did not exist.
	EgressAllow []netip.Addr
}

// GatewayUnit renders hermes-gateway.service.
func GatewayUnit(p GatewayParams) (string, error) {
	allow, err := resolverPrefixes(p.EgressAllow)
	if err != nil {
		return "", err
	}
	return render("hermes-gateway.service.tmpl", map[string]any{
		"ServiceUser":   layout.ServiceUser,
		"RuntimeRoot":   layout.RuntimeRoot,
		"VenvBin":       layout.VenvBin,
		"GatewayPort":   layout.GatewayPort,
		"DockerEnabled": p.DockerEnabled,
		"UID":           p.UID,
		"EgressDeny":    layout.EgressDenyNetworks,
		"EgressAllow":   allow,
	})
}

// ConnectorUnit renders hermes-connector.service, the default instance.
// resolvers are the host's resolvers inside a denied range, as for
// GatewayParams.EgressAllow.
func ConnectorUnit(uid int, resolvers []netip.Addr) (string, error) {
	return connectorUnit(uid, false, resolvers)
}

// ConnectorTemplateUnit renders hermes-connector@.service: the same unit,
// with the link, the device key and the state directory keyed by the
// instance name (%i), so `link --name dev` runs next to the default link
// without sharing its journal, audit key or device key.
func ConnectorTemplateUnit(uid int, resolvers []netip.Addr) (string, error) {
	return connectorUnit(uid, true, resolvers)
}

func connectorUnit(uid int, instance bool, resolvers []netip.Addr) (string, error) {
	allow, err := resolverPrefixes(resolvers)
	if err != nil {
		return "", err
	}
	inst := layout.DefaultConnectorInstance
	stateDirectory := layout.ConnectorUnit
	if instance {
		inst = layout.ConnectorInstance("%i")
		stateDirectory = layout.ConnectorUnit + "/%i"
	}
	return render("hermes-connector.service.tmpl", map[string]any{
		"ConnectorUser":  layout.ConnectorUser,
		"GatewayUnit":    layout.GatewayUnit,
		"Instance":       instance,
		"LinkPath":       inst.LinkPath(),
		"DeviceKeyPath":  inst.DeviceKeyPath(),
		"StateDirectory": stateDirectory,
		"RuntimeEnv":     layout.RuntimeEnv,
		"RuntimeRoot":    layout.RuntimeRoot,
		"ToolPath":       layout.ToolInstalledPath,
		"UID":            uid,
		"EgressDeny":     layout.EgressDenyNetworks,
		"EgressAllow":    allow,
	})
}

// OperatorUnit renders hermes-operator.service. resolvers are the host's
// resolvers inside a denied range, as for GatewayParams.EgressAllow.
func OperatorUnit(resolvers []netip.Addr) (string, error) {
	allow, err := resolverPrefixes(resolvers)
	if err != nil {
		return "", err
	}
	return render("hermes-operator.service.tmpl", map[string]any{
		"ConnectorUser": layout.ConnectorUser,
		"OperatorUnit":  layout.OperatorUnit,
		"GatewayUnit":   layout.GatewayUnit,
		"RuntimeRoot":   layout.RuntimeRoot,
		"ToolPath":      layout.ToolInstalledPath,
		"EgressDeny":    layout.EgressDenyNetworks,
		"EgressAllow":   allow,
	})
}

// HardeningRollbackService renders hermes-hardening-rollback.service.
func HardeningRollbackService() (string, error) {
	return render("hermes-hardening-rollback.service.tmpl", map[string]any{
		"ActiveMarker": layout.HardeningActive,
		"ToolPath":     layout.ToolInstalledPath,
	})
}

// HardeningRollbackTimer renders hermes-hardening-rollback.timer. The delay
// is not a parameter: a tunable window is a lockout.
func HardeningRollbackTimer() (string, error) {
	return render("hermes-hardening-rollback.timer.tmpl", map[string]any{
		"ActiveMarker": layout.HardeningActive,
		"DelaySeconds": layout.HardeningRollbackDelaySeconds,
		"Unit":         layout.HardeningRollbackUnit,
	})
}

// AutoUpgradeService renders hermes-setup-upgrade.service, the oneshot pass
// behind `auto-upgrade enable`.
func AutoUpgradeService() (string, error) {
	return render("hermes-setup-upgrade.service.tmpl", map[string]any{
		"ToolPath": layout.ToolInstalledPath,
	})
}

// AutoUpgradeTimer renders hermes-setup-upgrade.timer.
func AutoUpgradeTimer() (string, error) {
	return render("hermes-setup-upgrade.timer.tmpl", map[string]any{
		"Unit": layout.AutoUpgradeUnit,
	})
}

// LoopbackGuardUnit renders hermes-loopback-guard.service. Each rule is one
// iptables OUTPUT specification, already joined as arguments; the unit
// deletes then inserts every one of them at the head of the chain.
func LoopbackGuardUnit(rules []string) (string, error) {
	return render("hermes-loopback-guard.service.tmpl", map[string]any{"Rules": rules})
}

// SSHDropin renders the sshd hardening drop-in for the admin user.
func SSHDropin(adminUser string) (string, error) {
	return render("00-hermes-hardening.conf.tmpl", map[string]any{"AdminUser": adminUser})
}

// Fail2banJail renders /etc/fail2ban/jail.d/sshd.local. ignoreIP is the
// space-separated exemption list: loopback, plus the operator's own address
// when this run arrived over SSH (hardening.MergeIgnoreIP builds it).
func Fail2banJail(ignoreIP string) (string, error) {
	return render("sshd.local.tmpl", map[string]any{"SSHPort": layout.SSHPort, "IgnoreIP": ignoreIP})
}

// SudoersAdmin renders /etc/sudoers.d/80-hermes-admin.
func SudoersAdmin(adminUser string) (string, error) {
	return render("80-hermes-admin.tmpl", map[string]any{"AdminUser": adminUser})
}

// SudoersLogging renders /etc/sudoers.d/81-hermes-logging.
func SudoersLogging() (string, error) {
	return render("81-hermes-logging.tmpl", map[string]any{"SudoLog": layout.SudoLog})
}

// SudoLogrotate renders /etc/logrotate.d/hermes-sudo.
func SudoLogrotate() (string, error) {
	return render("hermes-sudo-logrotate.tmpl", map[string]any{"SudoLog": layout.SudoLog})
}

// PwqualityDropin renders the pwquality policy.
func PwqualityDropin() (string, error) {
	return render("90-hermes-pwquality.conf.tmpl", map[string]any{"MinLength": layout.PasswordMinLength})
}

// ResolvedDropin renders the systemd-resolved drop-in (LLMNR off).
func ResolvedDropin() (string, error) { return render("90-hermes-resolved.conf.tmpl", nil) }

// AptAutoUpgrades renders /etc/apt/apt.conf.d/20auto-upgrades.
func AptAutoUpgrades() (string, error) { return render("20auto-upgrades.tmpl", nil) }

// AptUnattended renders /etc/apt/apt.conf.d/52-hermes-unattended.
func AptUnattended() (string, error) { return render("52-hermes-unattended.tmpl", nil) }

// DockerDaemonJSON renders the rootless daemon.json (log rotation).
func DockerDaemonJSON() (string, error) { return render("docker-daemon.json.tmpl", nil) }

// DockerDelegateConf renders user@.service.d/delegate.conf.
func DockerDelegateConf() (string, error) { return render("docker-delegate.conf.tmpl", nil) }

// DockerModulesLoad renders the modules-load.d entry for nf_tables.
func DockerModulesLoad() (string, error) { return render("docker-modules-load.conf.tmpl", nil) }

// DockerSources renders the deb822 apt source for Docker CE.
func DockerSources(codename, debArch string) (string, error) {
	return render("docker.sources.tmpl", map[string]any{"Codename": codename, "Arch": debArch})
}
