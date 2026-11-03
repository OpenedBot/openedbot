// Package audit is the read-only security inventory of the host. It is a
// native port of the checks the previous tool ran through vps-audit
// (nuver-labs, MIT, see assets/NOTICE-vps-audit), plus the Hermes-specific
// gates: loopback-only gateway, exact toolset catalogue, cloud-metadata
// egress denied, sandbox backend, and no messaging platform enabled on the
// host without an explicit allowlist.
package audit

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/egress"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Status of a check.
type Status string

// Statuses.
const (
	Pass    Status = "PASS"
	Warn    Status = "WARN"
	Fail    Status = "FAIL"
	Unknown Status = "UNKNOWN"
	Skip    Status = "SKIP"
)

// Result is one check.
type Result struct {
	ID      string
	Status  Status
	Message string
}

// Report is the outcome of a run.
type Report struct {
	At      time.Time
	Results []Result
	Path    string
}

// Counts summarises statuses.
func (r Report) Counts() (pass, warn, fail, unknown, skip int) {
	for _, x := range r.Results {
		switch x.Status {
		case Pass:
			pass++
		case Warn:
			warn++
		case Fail:
			fail++
		case Skip:
			skip++
		default:
			unknown++
		}
	}
	return
}

// Strict reports whether the audit blocks (any FAIL or UNKNOWN).
func (r Report) Strict() bool {
	_, _, f, u, _ := r.Counts()
	return f == 0 && u == 0
}

// Auditor carries dependencies.
type Auditor struct {
	Runner   exec.Runner
	Systemd  systemd.Client
	Accounts account.Client
	State    *state.File
	ReportTo string
	// Root prefixes file reads (tests).
	Root string
}

// New wires an auditor writing to the canonical report directory.
func New(r exec.Runner, st *state.File) *Auditor {
	return &Auditor{Runner: r, Systemd: systemd.Client{Runner: r}, Accounts: account.New(r), State: st, ReportTo: layout.AuditDir, Root: "/"}
}

func (a *Auditor) path(p string) string { return filepath.Join(a.Root, p) }

func (a *Auditor) read(p string) string {
	b, err := os.ReadFile(a.path(p))
	if err != nil {
		return ""
	}
	return string(b)
}

func (a *Auditor) out(ctx context.Context, path string, args ...string) (string, bool) {
	res, err := a.Runner.Run(ctx, exec.Cmd{Path: path, Args: args, Env: []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}})
	if err != nil {
		return "", false
	}
	return res.Stdout, res.ExitCode == 0
}

// Run executes every check and writes the root-only report.
func (a *Auditor) Run(ctx context.Context) (Report, error) {
	rep := Report{At: time.Now().UTC()}
	add := func(id string, st Status, msg string) {
		rep.Results = append(rep.Results, Result{ID: id, Status: st, Message: msg})
	}
	type check struct {
		id      string
		run     func(context.Context) Result
		enabled bool
	}
	f := state.Features{}
	if a.State != nil {
		f = a.State.Features
	}
	checks := []check{
		{"privileges", a.privileges, true}, {"hermes_account", a.hermesAccount, true}, {"restart_required", a.restart, true},
		{"ssh", a.ssh, f.SSHHardening}, {"firewall", a.firewall, f.Firewall}, {"cloud_metadata_egress", a.metadataEgress, true},
		{"unattended_upgrades", a.unattended, f.UnattendedUpgrades}, {"intrusion_prevention", a.fail2ban, f.Fail2Ban}, {"failed_logins", a.failedLogins, f.SSHHardening || f.Fail2Ban},
		{"package_updates", a.packageUpdates, f.UnattendedUpgrades}, {"listening_ports", a.listeningPorts, true}, {"disk_usage", a.disk, true}, {"memory_usage", a.memory, true}, {"cpu_usage", a.load, true},
		{"sudo_logging", a.sudoLogging, f.SudoLogging}, {"password_policy", a.passwordPolicy, f.PasswordPolicy}, {"llmnr", a.llmnr, f.DisableLLMNR}, {"privileged_files", a.privilegedFiles, true}, {"sudoers", a.sudoers, true},
		{"hermes_gateway", a.hermesGateway, true}, {"hermes_gateway_unit", a.hermesGatewayUnit, true}, {"hermes_catalogue", a.hermesCatalogue, true}, {"hermes_sandbox", a.hermesSandbox, f.Sandbox}, {"hermes_platforms", a.hermesPlatforms, true}, {"hermes_secrets", a.hermesSecrets, true},
		{"proxy_transaction", a.proxyTransaction, true},
	}
	for _, c := range checks {
		if !c.enabled {
			add(c.id, Skip, "not selected by the host owner")
			continue
		}
		r := c.run(ctx)
		add(r.ID, r.Status, r.Message)
	}
	if a.ReportTo != "" {
		if err := fsx.EnsureDir(a.ReportTo, 0o700, fsx.Root); err != nil {
			return rep, err
		}
		rep.Path = filepath.Join(a.ReportTo, rep.At.Format("20060102T150405Z")+".txt")
		var b strings.Builder
		fmt.Fprintf(&b, "edge-setup audit %s\n", rep.At.Format(time.RFC3339))
		for _, r := range rep.Results {
			fmt.Fprintf(&b, "%s %s: %s\n", r.Status, r.ID, r.Message)
		}
		p, w, f, u, s := rep.Counts()
		fmt.Fprintf(&b, "SUMMARY pass=%d warn=%d fail=%d unknown=%d skip=%d\n", p, w, f, u, s)
		if err := fsx.WriteAtomic(rep.Path, []byte(b.String()), 0o600, fsx.Root); err != nil {
			return rep, err
		}
	}
	return rep, nil
}

func (a *Auditor) hermesAccount(ctx context.Context) Result {
	accounts := account.New(a.Runner)
	info, err := accounts.Get(ctx, layout.ServiceUser)
	if err != nil || info == nil {
		return Result{"hermes_account", Fail, "mandatory hermes service account is missing"}
	}
	if info.Shell != "/usr/sbin/nologin" {
		return Result{"hermes_account", Fail, "hermes must use /usr/sbin/nologin"}
	}
	if err := accounts.RequireUnprivileged(ctx, layout.ServiceUser); err != nil {
		return Result{"hermes_account", Fail, err.Error()}
	}
	return Result{"hermes_account", Pass, "single service account, nologin, no sudo/docker group"}
}

func (a *Auditor) privileges(context.Context) Result {
	if os.Geteuid() != 0 {
		return Result{"privileges", Fail, "audit must run as root to read policies"}
	}
	return Result{"privileges", Pass, "running as root"}
}

// proxyTransaction fails while a public exposure is still uncommitted: the
// rollback timer is about to close the ports, so the host is not in the
// state the operator thinks it is.
func (a *Auditor) proxyTransaction(context.Context) Result {
	if fsx.Exists(a.path(layout.ProxyActive)) {
		return Result{"proxy_transaction", Fail, "an old proxy transaction is still armed; run connector-only `up` to retire it safely, or let its timer restore the host"}
	}
	if fsx.Exists(a.path(layout.ProxyStateDir + "/rolled-back")) {
		return Result{"proxy_transaction", Warn, "the proxy rollback ran: the public exposure was undone"}
	}
	return Result{"proxy_transaction", Pass, "no proxy transaction pending"}
}

func (a *Auditor) restart(context.Context) Result {
	if fsx.Exists(a.path("/var/run/reboot-required")) {
		return Result{"restart_required", Warn, "a reboot is pending"}
	}
	return Result{"restart_required", Pass, "no reboot pending"}
}

func (a *Auditor) ssh(ctx context.Context) Result {
	out, ok := a.out(ctx, "/usr/sbin/sshd", "-T")
	if !ok {
		return Result{"ssh", Unknown, "sshd -T failed"}
	}
	eff := hardening.SSHDEffective(out)
	if a.State != nil && a.State.SSHHardening {
		if err := hardening.RequireSSHDHardened(eff, layout.AdminUser); err != nil {
			return Result{"ssh", Fail, err.Error()}
		}
		return Result{"ssh", Pass, "key-only, root disabled, AllowUsers " + layout.AdminUser}
	}
	if eff["passwordauthentication"] != "no" || eff["permitrootlogin"] == "yes" {
		return Result{"ssh", Warn, fmt.Sprintf("password auth %s, root login %s (no SSH hardening requested)", eff["passwordauthentication"], eff["permitrootlogin"])}
	}
	return Result{"ssh", Pass, "password auth off, root login " + eff["permitrootlogin"]}
}

func (a *Auditor) expectedPorts() []int {
	if a.State == nil || !a.State.Features.Firewall {
		return nil
	}
	var ports []int
	for _, rule := range a.State.Features.AllowedInbound {
		parts := strings.Split(rule, "/")
		if len(parts) == 2 && parts[1] == "tcp" {
			p, _ := strconv.Atoi(parts[0])
			ports = append(ports, p)
		}
	}
	return ports
}

// expectedListeners are the non-loopback listeners the host legitimately
// carries: the public ports, plus sshd when SSH hardening was not requested
// (the host keeps its own sshd; UFW then does not open it).
func (a *Auditor) expectedListeners() map[int]bool {
	m := map[int]bool{}
	for _, p := range a.expectedPorts() {
		m[p] = true
	}
	return m
}

func (a *Auditor) firewall(ctx context.Context) Result {
	out, ok := a.out(ctx, "/usr/sbin/ufw", "status")
	if !ok {
		return Result{"firewall", Unknown, "ufw status failed"}
	}
	if !hardening.UFWStatusActive(out) {
		return Result{"firewall", Fail, "UFW is not active"}
	}
	allowed := hardening.UFWAllowedInPorts(out)
	if a.State != nil {
		if err := hardening.RequireExactRules(allowed, a.State.Features.AllowedInbound); err != nil {
			return Result{"firewall", Fail, err.Error()}
		}
	}
	return Result{"firewall", Pass, "UFW active, inbound allow: " + strings.Join(allowed, " ")}
}

func (a *Auditor) metadataEgress(ctx context.Context) Result {
	if a.State != nil && a.State.Features.Firewall {
		out, ok := a.out(ctx, "/usr/sbin/ufw", "status")
		if !ok {
			return Result{"cloud_metadata_egress", Unknown, "ufw status failed"}
		}
		for _, n := range layout.EgressDenyNetworks {
			if !hardening.UFWDeniesOut(out, n) {
				return Result{"cloud_metadata_egress", Fail, "egress to " + n + " is not denied by selected UFW policy"}
			}
		}
	}
	unit, _ := a.Systemd.Show(ctx, layout.GatewayUnit, "IPAddressDeny")
	if !strings.Contains(unit, "169.254.0.0/16") {
		return Result{"cloud_metadata_egress", Fail, "gateway unit carries no mandatory IPAddressDeny"}
	}
	// A deny line alone proves nothing: systemd grants an address that matches
	// IPAddressAllow= before it reads IPAddressDeny= (systemd.resource-control(5)).
	// Units rendered before the allow line was dropped still carry
	// IPAddressAllow=any and refuse nothing. The one entry that may overlap a
	// metadata range is a configured nameserver allowed alone, as a single host
	// (internal/egress): the unit keeps its DNS, and metadata stays reachable
	// through that address.
	allow, err := a.Systemd.Show(ctx, layout.GatewayUnit, "IPAddressAllow")
	if err != nil {
		return Result{"cloud_metadata_egress", Unknown, "systemctl show IPAddressAllow failed"}
	}
	shadow, resolvers := overlappingAllow(allow, egress.Nameservers(a.read(layout.ResolvConf)))
	if shadow != "" {
		return Result{"cloud_metadata_egress", Fail, "gateway unit allows " + shadow + " ahead of its IPAddressDeny, so the metadata ranges stay reachable; `sudo edge-setup upgrade --yes`, or `sudo edge-setup up --yes`, renders the current unit"}
	}
	if len(resolvers) > 0 {
		return Result{"cloud_metadata_egress", Warn, "gateway unit allows nameserver " + strings.Join(resolvers, ", ") + " inside the denied range: cloud metadata stays reachable through that resolver address (on GCE and OCI it is the metadata server itself); make the systemd-resolved stub (127.0.0.53) the nameserver and run `sudo edge-setup upgrade --yes` (or `sudo edge-setup up --yes`) to drop the exception"}
	}
	return Result{"cloud_metadata_egress", Pass, "denied by the gateway unit"}
}

// overlappingAllow scans a `systemctl show --value IPAddressAllow` output
// (space-separated address/prefix pairs, `any` shown as ::/0 and 0.0.0.0/0)
// for the entries that overlap a metadata range. An entry that is exactly one
// of the nameservers is a resolver exception and is returned in resolvers;
// the first other overlapping entry is returned as shadow, and ends the scan.
// An entry it cannot read counts as shadowing: an unproven deny is not a pass.
func overlappingAllow(allow string, nameservers []netip.Addr) (shadow string, resolvers []string) {
	for _, entry := range strings.Fields(allow) {
		prefix, err := netip.ParsePrefix(entry)
		if err != nil {
			return entry, nil
		}
		overlaps := false
		for _, network := range layout.EgressDenyNetworks {
			if denied, err := netip.ParsePrefix(network); err == nil && prefix.Overlaps(denied) {
				overlaps = true
			}
		}
		if !overlaps {
			continue
		}
		if prefix.IsSingleIP() && slices.Contains(nameservers, prefix.Addr()) {
			resolvers = append(resolvers, prefix.Addr().String())
			continue
		}
		return entry, nil
	}
	return "", resolvers
}

func (a *Auditor) llmnr(ctx context.Context) Result {
	out, ok := a.out(ctx, "/usr/bin/ss", "-H", "-ltnup")
	if !ok {
		return Result{"llmnr", Unknown, "ss failed"}
	}
	if hardening.ListenerOnPort(out, 5355) {
		return Result{"llmnr", Fail, "LLMNR listener remains on :5355"}
	}
	return Result{"llmnr", Pass, "no LLMNR listener on :5355"}
}

func (a *Auditor) unattended(ctx context.Context) Result {
	for _, t := range []string{"apt-daily.timer", "apt-daily-upgrade.timer"} {
		if en, _ := a.Systemd.IsEnabled(ctx, t); !en {
			return Result{"unattended_upgrades", Warn, t + " is not enabled"}
		}
	}
	if !strings.Contains(a.read(layout.AptAutoUpgrades), `Unattended-Upgrade "1"`) {
		return Result{"unattended_upgrades", Warn, "unattended-upgrades is not configured"}
	}
	return Result{"unattended_upgrades", Pass, "enabled, no automatic reboot"}
}

func (a *Auditor) fail2ban(ctx context.Context) Result {
	if active, _ := a.Systemd.IsActive(ctx, "fail2ban"); !active {
		return Result{"intrusion_prevention", Fail, "fail2ban is not active"}
	}
	out, ok := a.out(ctx, "/usr/bin/fail2ban-client", "status", "sshd")
	if !ok || !strings.Contains(out, "Journal matches") && !strings.Contains(out, "File list") && !strings.Contains(out, "Currently banned") {
		return Result{"intrusion_prevention", Fail, "the sshd jail is not running"}
	}
	return Result{"intrusion_prevention", Pass, "fail2ban sshd jail active"}
}

func (a *Auditor) failedLogins(ctx context.Context) Result {
	out, ok := a.out(ctx, "/usr/bin/journalctl", "-u", "ssh.service", "--since", "24 hours ago", "--no-pager", "-o", "cat")
	if !ok {
		return Result{"failed_logins", Unknown, "journalctl failed"}
	}
	n := strings.Count(out, "Failed password") + strings.Count(out, "Invalid user")
	switch {
	case n > 500:
		return Result{"failed_logins", Warn, fmt.Sprintf("%d failed SSH logins in 24 h", n)}
	default:
		return Result{"failed_logins", Pass, fmt.Sprintf("%d failed SSH logins in 24 h", n)}
	}
}

func (a *Auditor) packageUpdates(ctx context.Context) Result {
	out, ok := a.out(ctx, "/usr/bin/apt-get", "-s", "upgrade")
	if !ok {
		return Result{"package_updates", Unknown, "apt-get -s upgrade failed"}
	}
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "Inst ") {
			n++
		}
	}
	if n > 0 {
		return Result{"package_updates", Warn, fmt.Sprintf("%d package updates pending", n)}
	}
	return Result{"package_updates", Pass, "no pending package update"}
}

var listenRe = regexp.MustCompile(`(?m)^LISTEN\s+\S+\s+\S+\s+(\S+):(\d+)\s`)

// isLoopbackAddr reports whether an `ss` local address is unreachable from
// outside the host. The whole of 127.0.0.0/8 is loopback, not just
// 127.0.0.1: systemd-resolved binds its stub on 127.0.0.53 and its extra
// listener on 127.0.0.54, and `ss` appends the interface scope (%lo) to
// them. Treating those as public listeners warned on every correctly
// configured Debian host, including the one this tool sets up itself.
func isLoopbackAddr(addr string) bool {
	if i := strings.IndexByte(addr, '%'); i >= 0 {
		addr = addr[:i]
	}
	addr = strings.Trim(addr, "[]")
	if addr == "*" || addr == "0.0.0.0" || addr == "::" {
		return false
	}
	ip := net.ParseIP(addr)
	return ip != nil && ip.IsLoopback()
}

func (a *Auditor) listeningPorts(ctx context.Context) Result {
	out, ok := a.out(ctx, "/usr/bin/ss", "-H", "-ltn")
	if !ok {
		return Result{"listening_ports", Unknown, "ss failed"}
	}
	allowed := a.expectedListeners()
	var public []string
	for _, m := range listenRe.FindAllStringSubmatch(out, -1) {
		addr, port := m[1], m[2]
		p, _ := strconv.Atoi(port)
		if isLoopbackAddr(addr) {
			continue
		}
		if a.State != nil && !allowed[p] {
			public = append(public, addr+":"+port)
		}
	}
	sort.Strings(public)
	if len(public) > 0 {
		return Result{"listening_ports", Warn, "non-loopback listeners outside the selected HVS policy: " + strings.Join(public, " ")}
	}
	return Result{"listening_ports", Pass, "only expected public listeners"}
}

func (a *Auditor) disk(ctx context.Context) Result {
	out, ok := a.out(ctx, "/bin/df", "-P", "/")
	if !ok {
		return Result{"disk_usage", Unknown, "df failed"}
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 2 {
		return Result{"disk_usage", Unknown, "df output unreadable"}
	}
	f := strings.Fields(lines[1])
	if len(f) < 5 {
		return Result{"disk_usage", Unknown, "df output unreadable"}
	}
	pct, _ := strconv.Atoi(strings.TrimSuffix(f[4], "%"))
	switch {
	case pct >= 90:
		return Result{"disk_usage", Fail, fmt.Sprintf("/ is %d%% full", pct)}
	case pct >= 75:
		return Result{"disk_usage", Warn, fmt.Sprintf("/ is %d%% full", pct)}
	}
	return Result{"disk_usage", Pass, fmt.Sprintf("/ is %d%% full", pct)}
}

func (a *Auditor) memory(context.Context) Result {
	mem := a.read("/proc/meminfo")
	total, avail := meminfoKB(mem, "MemTotal:"), meminfoKB(mem, "MemAvailable:")
	if total == 0 {
		return Result{"memory_usage", Unknown, "meminfo unreadable"}
	}
	pct := 100 - avail*100/total
	if pct >= 90 {
		return Result{"memory_usage", Warn, fmt.Sprintf("memory %d%% used", pct)}
	}
	return Result{"memory_usage", Pass, fmt.Sprintf("memory %d%% used", pct)}
}

func meminfoKB(mem, key string) int {
	for _, line := range strings.Split(mem, "\n") {
		if v, ok := strings.CutPrefix(line, key); ok {
			n, _ := strconv.Atoi(strings.Fields(v)[0])
			return n
		}
	}
	return 0
}

func (a *Auditor) load(context.Context) Result {
	f := strings.Fields(a.read("/proc/loadavg"))
	if len(f) < 1 {
		return Result{"cpu_usage", Unknown, "loadavg unreadable"}
	}
	load, _ := strconv.ParseFloat(f[0], 64)
	cpus := float64(runtimeCPUs())
	if load > cpus*2 {
		return Result{"cpu_usage", Warn, fmt.Sprintf("load %.2f on %d vCPU", load, int(cpus))}
	}
	return Result{"cpu_usage", Pass, fmt.Sprintf("load %.2f on %d vCPU", load, int(cpus))}
}

func (a *Auditor) sudoLogging(context.Context) Result {
	if !strings.Contains(a.read(layout.SudoersLogging), "logfile=") {
		return Result{"sudo_logging", Fail, "sudo is not configured to log to " + layout.SudoLog}
	}
	if _, err := fsx.RequireRegular(a.path(layout.SudoLog), 0o600, fsx.Root); err != nil {
		return Result{"sudo_logging", Fail, err.Error()}
	}
	return Result{"sudo_logging", Pass, "sudo logs to " + layout.SudoLog + " (0600)"}
}

func (a *Auditor) passwordPolicy(context.Context) Result {
	dropins := map[string]string{}
	for _, dir := range []string{"/usr/lib/security/pwquality.conf.d", "/etc/security/pwquality.conf.d"} {
		m, _ := filepath.Glob(a.path(dir) + "/*.conf")
		for _, p := range m {
			b, _ := os.ReadFile(p)
			dropins[filepath.Base(p)] = string(b)
		}
	}
	main := a.read("/etc/security/pwquality.conf")
	if main == "" {
		main = a.read("/usr/lib/security/pwquality.conf")
	}
	managed := a.read(layout.PwqualityDropin)
	if err := hardening.RequirePwquality(hardening.EffectivePwquality(dropins, main), managed, layout.PasswordMinLength); err != nil {
		return Result{"password_policy", Fail, err.Error()}
	}
	if err := hardening.PAMGate(a.read("/etc/pam.d/common-password")); err != nil {
		return Result{"password_policy", Fail, err.Error()}
	}
	return Result{"password_policy", Pass, fmt.Sprintf("minlen %d, credits 0, enforcing, root included", layout.PasswordMinLength)}
}

// managedTrees are the trees this tool writes or that its units execute
// from; privilegedFiles scans those that exist.
var managedTrees = []string{"/usr/local", "/srv/hermes", "/etc/hermes", layout.ToolStateDir, layout.ConnectorStateDir, layout.OperatorStateDir, layout.AuditDir}

func (a *Auditor) privilegedFiles(ctx context.Context) Result {
	var roots []string
	for _, p := range managedTrees {
		if fsx.Exists(a.path(p)) {
			roots = append(roots, a.path(p))
		}
	}
	if len(roots) == 0 {
		return Result{"privileged_files", Pass, "no managed tree on this host yet"}
	}
	// Files that are setuid, setgid or world-writable, and directories that
	// are world-writable without the sticky bit. The running gateway creates
	// and removes files under /srv/hermes during the walk: an entry that
	// vanishes between readdir and stat is not an error (-ignore_readdir_race),
	// any other one still is.
	args := append(roots, "-ignore_readdir_race", "-xdev", "(", "-type", "f", "(", "-perm", "-4000", "-o", "-perm", "-2000", "-o", "-perm", "-0002", ")", ")",
		"-o", "(", "-type", "d", "-perm", "-0002", "!", "-perm", "-1000", ")", "-print")
	out, ok := a.out(ctx, "/usr/bin/find", args...)
	if !ok {
		return Result{"privileged_files", Unknown, "find failed"}
	}
	files := strings.Fields(out)
	scope := strings.Join(managedTrees, ", ")
	if len(files) > 0 {
		return Result{"privileged_files", Fail, "setuid/setgid or world-writable entries under " + scope + ": " + strings.Join(files, " ")}
	}
	return Result{"privileged_files", Pass, "no setuid/setgid/world-writable entry under " + scope}
}

// sudoers proves the service account holds no sudo rule, and that the one
// rule this tool can write (the key-only administrator of --ssh-hardening)
// exists only when that option was chosen.
func (a *Auditor) sudoers(context.Context) Result {
	entries, err := os.ReadDir(a.path("/etc/sudoers.d"))
	if err != nil && !os.IsNotExist(err) {
		return Result{"sudoers", Unknown, "/etc/sudoers.d: " + err.Error()}
	}
	for _, e := range entries {
		for _, line := range strings.Split(a.read("/etc/sudoers.d/"+e.Name()), "\n") {
			fields := strings.Fields(line)
			if len(fields) > 0 && (fields[0] == layout.ServiceUser || fields[0] == "%"+layout.ServiceUser) {
				return Result{"sudoers", Fail, fmt.Sprintf("/etc/sudoers.d/%s grants sudo to the service account %s", e.Name(), layout.ServiceUser)}
			}
		}
	}
	sshHardening := a.State != nil && a.State.Features.SSHHardening
	if fsx.Exists(a.path(layout.SudoersAdmin)) && !sshHardening {
		return Result{"sudoers", Fail, layout.SudoersAdmin + " exists but --ssh-hardening was not selected"}
	}
	if sshHardening {
		mode := a.State.AdminSudo
		if mode == "" {
			mode = layout.AdminSudoNoPasswd // hardened before --admin-sudo existed
		}
		if mode == layout.AdminSudoPassword && strings.Contains(a.read(layout.SudoersAdmin), "NOPASSWD") {
			return Result{"sudoers", Fail, layout.SudoersAdmin + " grants NOPASSWD but --admin-sudo=" + layout.AdminSudoPassword + " was chosen"}
		}
		return Result{"sudoers", Pass, "no sudo rule for " + layout.ServiceUser + "; " + layout.AdminUser + " has the administrator rule of --ssh-hardening (" + mode + ")"}
	}
	return Result{"sudoers", Pass, "no sudo rule for " + layout.ServiceUser + " and none written by this tool"}
}

func (a *Auditor) hermesGateway(ctx context.Context) Result {
	if active, _ := a.Systemd.IsActive(ctx, layout.GatewayUnit); !active {
		return Result{"hermes_gateway", Fail, layout.GatewayUnit + " is not active"}
	}
	out, ok := a.out(ctx, "/usr/bin/ss", "-H", "-ltn")
	if !ok {
		return Result{"hermes_gateway", Unknown, "ss failed"}
	}
	if hardening.PublicListener(out, layout.GatewayPort) {
		return Result{"hermes_gateway", Fail, fmt.Sprintf("the gateway listens publicly on :%d", layout.GatewayPort)}
	}
	if !hardening.LoopbackListener(out, layout.GatewayPort) {
		return Result{"hermes_gateway", Fail, fmt.Sprintf("no loopback listener on :%d", layout.GatewayPort)}
	}
	for _, p := range []int{9119} {
		if hardening.PublicListener(out, p) {
			return Result{"hermes_gateway", Fail, fmt.Sprintf("private port :%d listens publicly", p)}
		}
	}
	return Result{"hermes_gateway", Pass, fmt.Sprintf("gateway on 127.0.0.1:%d only", layout.GatewayPort)}
}

// hermesGatewayUnit compares the installed gateway unit with the one this
// binary renders for this host (hermes.DesiredGatewayUnit: the text `up` writes,
// with the parameters `up` reads). A difference is a warning, not a failure: the
// runtime works, it only lacks what a newer release changed in the unit. `upgrade`
// and `up` both bring it. A parameter that cannot be derived leaves the check
// UNKNOWN: no verdict is made on a guess.
func (a *Auditor) hermesGatewayUnit(ctx context.Context) Result {
	installed, err := os.ReadFile(a.path(layout.GatewayUnitPath))
	if errors.Is(err, fs.ErrNotExist) {
		return Result{"hermes_gateway_unit", Fail, layout.GatewayUnit + ".service is not installed; run `sudo edge-setup up --yes`"}
	}
	if err != nil {
		return Result{"hermes_gateway_unit", Unknown, err.Error()}
	}
	accounts := a.Accounts
	if accounts.Lookup == nil {
		accounts = account.New(a.Runner)
	}
	want, err := hermes.DesiredGatewayUnit(ctx, accounts, a.State, a.path(layout.ResolvConf), nil)
	if err != nil {
		return Result{"hermes_gateway_unit", Unknown, "the unit this binary would install cannot be rendered: " + err.Error()}
	}
	if string(installed) != want {
		return Result{"hermes_gateway_unit", Warn, hermes.GatewayUnitStale}
	}
	return Result{"hermes_gateway_unit", Pass, layout.GatewayUnit + ".service is the unit this binary renders"}
}

func (a *Auditor) hermesCatalogue(ctx context.Context) Result {
	token, err := hermes.Token()
	if err != nil {
		return Result{"hermes_catalogue", Unknown, err.Error()}
	}
	c := gateway.Loopback(token)
	if err := c.RequireUnauthorizedWithoutBearer(ctx); err != nil {
		return Result{"hermes_catalogue", Fail, err.Error()}
	}
	names, err := c.Toolsets(ctx)
	if err != nil {
		return Result{"hermes_catalogue", Unknown, err.Error()}
	}
	if err := gateway.RequireToolsetPolicy(names); err != nil {
		return Result{"hermes_catalogue", Fail, err.Error()}
	}
	return Result{"hermes_catalogue", Pass, "anonymous refused, no forbidden toolset enabled"}
}

func (a *Auditor) hermesSandbox(ctx context.Context) Result {
	res, err := a.Runner.Run(ctx, hermes.CLI("config", "get", "terminal.backend"))
	if err != nil || res.ExitCode != 0 {
		return Result{"hermes_sandbox", Unknown, "terminal.backend unreadable"}
	}
	backend := strings.TrimSpace(res.Stdout)
	if backend != "docker" {
		return Result{"hermes_sandbox", Fail, "terminal.backend is " + backend + ", want docker"}
	}
	return Result{"hermes_sandbox", Pass, "terminal.backend=docker (rootless)"}
}

// platformTokens are the env keys that enable a messaging platform on the
// gateway. On a runtime meant for openedbot none should be set: a
// discoverable bot with an open DM policy is remote code execution.
var platformTokens = []string{"TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "WHATSAPP_TOKEN", "MATRIX_ACCESS_TOKEN", "SIGNAL_ACCOUNT", "MATTERMOST_TOKEN", "DINGTALK_APP_SECRET"}

func (a *Auditor) hermesPlatforms(context.Context) Result {
	env := a.read(layout.RuntimeRoot + "/.env")
	if env == "" {
		return Result{"hermes_platforms", Pass, "no platform configured on the host (messaging is handled by openedbot)"}
	}
	kv := map[string]string{}
	for _, line := range strings.Split(env, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			kv[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	var enabled []string
	for _, k := range platformTokens {
		if kv[k] != "" {
			enabled = append(enabled, k)
		}
	}
	if len(enabled) == 0 {
		return Result{"hermes_platforms", Pass, "no platform token on the host"}
	}
	if strings.EqualFold(kv["GATEWAY_ALLOW_ALL_USERS"], "true") {
		return Result{"hermes_platforms", Fail, "GATEWAY_ALLOW_ALL_USERS=true with a platform enabled: anyone can drive the agent"}
	}
	if kv["TELEGRAM_BOT_TOKEN"] != "" && (kv["TELEGRAM_ALLOWED_USERS"] == "" || kv["TELEGRAM_ALLOWED_USERS"] == "*") {
		return Result{"hermes_platforms", Fail, "Telegram enabled without a numeric TELEGRAM_ALLOWED_USERS allowlist"}
	}
	return Result{"hermes_platforms", Warn, "platforms enabled on the host (" + strings.Join(enabled, ", ") + "); openedbot is meant to own messaging"}
}

func (a *Auditor) hermesSecrets(context.Context) Result {
	for _, p := range []string{layout.RuntimeEnv, layout.RuntimeRoot + "/.env", layout.RuntimeConfig} {
		st, err := fsx.Lstat(a.path(p))
		if err != nil || !st.Exists {
			continue
		}
		if st.Mode&0o077 != 0 {
			return Result{"hermes_secrets", Fail, fmt.Sprintf("%s is mode %04o (group/world readable)", p, st.Mode)}
		}
	}
	links := []string{layout.ConnectorLink}
	named, _ := filepath.Glob(a.path(layout.ConnectorDir + "/*/link.json"))
	for _, p := range named {
		links = append(links, strings.TrimPrefix(p, a.Root))
	}
	for _, link := range links {
		if st, _ := fsx.Lstat(a.path(link)); st.Exists && (st.Mode&0o077 != 0 || st.Owner.UID != 0) {
			return Result{"hermes_secrets", Fail, link + " must be root:root 0600"}
		}
	}
	return Result{"hermes_secrets", Pass, "runtime.env, .env, config.yaml and link.json are owner-only"}
}
