package render

import (
	"flag"
	"net"
	"net/netip"
	"os"
	osexec "os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

var update = flag.Bool("update", false, "rewrite golden files")

func golden(t *testing.T, name, got string) {
	t.Helper()
	p := filepath.Join("..", "..", "test", "golden", "render", name+".golden")
	if *update {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", p, err)
	}
	if string(want) != got {
		t.Errorf("%s differs from golden\n--- got ---\n%s\n--- want ---\n%s", name, got, want)
	}
}

func must(t *testing.T) func(string, error) string {
	return func(s string, err error) string {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
}

func TestGoldens(t *testing.T) {
	cases := map[string]string{
		"hermes-gateway.service.docker":     must(t)(GatewayUnit(GatewayParams{DockerEnabled: true, UID: 998})),
		"hermes-gateway.service.local":      must(t)(GatewayUnit(GatewayParams{DockerEnabled: false})),
		"hermes-connector.service":          must(t)(ConnectorUnit(998, nil)),
		"hermes-connector@.service":         must(t)(ConnectorTemplateUnit(998, nil)),
		"hermes-operator.service":           must(t)(OperatorUnit(nil)),
		"hermes-hardening-rollback.service": must(t)(HardeningRollbackService()),
		"hermes-hardening-rollback.timer":   must(t)(HardeningRollbackTimer()),
		"hermes-setup-upgrade.service":      must(t)(AutoUpgradeService()),
		"hermes-setup-upgrade.timer":        must(t)(AutoUpgradeTimer()),
		"hermes-loopback-guard.service":     must(t)(LoopbackGuardUnit([]string{"-o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable", "-o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 0 -j ACCEPT"})),
		"00-hermes-hardening.conf":          must(t)(SSHDropin("hermes-admin")),
		"sshd.local":                        must(t)(Fail2banJail("127.0.0.1/8 ::1 203.0.113.7")),
		"80-hermes-admin":                   must(t)(SudoersAdmin("hermes-admin", false)),
		"80-hermes-admin.nopasswd":          must(t)(SudoersAdmin("hermes-admin", true)),
		"81-hermes-logging":                 must(t)(SudoersLogging()),
		"hermes-sudo-logrotate":             must(t)(SudoLogrotate()),
		"90-hermes-pwquality.conf":          must(t)(PwqualityDropin()),
		"90-hermes-resolved.conf":           must(t)(ResolvedDropin()),
		"20auto-upgrades":                   must(t)(AptAutoUpgrades()),
		"52-hermes-unattended":              must(t)(AptUnattended()),
		"docker-daemon.json":                must(t)(DockerDaemonJSON()),
		"docker-delegate.conf":              must(t)(DockerDelegateConf()),
		"docker-modules-load.conf":          must(t)(DockerModulesLoad()),
		"docker.sources":                    must(t)(DockerSources("trixie", "amd64")),
	}
	for name, got := range cases {
		golden(t, name, got)
	}
}

// The invariants below are the ones a future edit is most likely to break
// while keeping the golden "looking right".
func TestGatewayUnitInvariants(t *testing.T) {
	for _, p := range []GatewayParams{{DockerEnabled: true, UID: 998}, {DockerEnabled: false}} {
		s := must(t)(GatewayUnit(p))
		for _, want := range []string{
			"User=hermes\n", "IPAddressDeny=169.254.0.0/16\n", "IPAddressDeny=fd00:ec2::/64\n",
			"NoNewPrivileges=true\n", "ProtectHome=tmpfs\n", "EnvironmentFile=/srv/hermes/data/runtime.env\n",
			"ExecStart=/usr/local/lib/hermes-agent/venv/bin/hermes gateway run --replace\n",
		} {
			if !strings.Contains(s, want) {
				t.Errorf("docker=%v: missing %q", p.DockerEnabled, want)
			}
		}
		if strings.Contains(s, "IPAddressDeny=127.") {
			t.Errorf("docker=%v: the gateway unit must never deny loopback", p.DockerEnabled)
		}
		hasSock := strings.Contains(s, "BindReadOnlyPaths=-/run/user/998/docker.sock")
		if hasSock != p.DockerEnabled {
			t.Errorf("docker=%v: rootless socket exposure = %v", p.DockerEnabled, hasSock)
		}
		// The bind is only real if the rootless daemon is up when the unit starts.
		ordered := strings.Contains(s, "After=user@998.service\n") && strings.Contains(s, "Wants=user@998.service\n")
		if ordered != p.DockerEnabled {
			t.Errorf("docker=%v: ordered after the service user's manager = %v", p.DockerEnabled, ordered)
		}
		// Ordering is not enough: the manager reports ready before its rootless
		// dockerd made the socket. The wait runs before ExecStart, as root.
		wait := strings.Index(s, "ExecStartPre=+/bin/sh -c 'test -e /home/hermes/.config/systemd/user/docker.service")
		if (wait >= 0) != p.DockerEnabled {
			t.Errorf("docker=%v: socket wait present = %v", p.DockerEnabled, wait >= 0)
		}
		if wait >= 0 && wait > strings.Index(s, "ExecStart=") {
			t.Errorf("docker=%v: the socket wait must run before ExecStart", p.DockerEnabled)
		}
	}
}

// socketWaitScript is the shell of the gateway unit's socket wait, as sh runs
// it once systemd unescaped $$.
func socketWaitScript(t *testing.T) string {
	t.Helper()
	unit := must(t)(GatewayUnit(GatewayParams{DockerEnabled: true, UID: 998}))
	const prefix = "ExecStartPre=+/bin/sh -c '"
	for _, line := range strings.Split(unit, "\n") {
		if strings.HasPrefix(line, prefix) && strings.HasSuffix(line, "'") {
			return strings.ReplaceAll(strings.TrimSuffix(strings.TrimPrefix(line, prefix), "'"), "$$", "$")
		}
	}
	t.Fatal("no socket wait in the docker gateway unit")
	return ""
}

// The wait never fails the unit: a missing rootless docker skips it, a socket
// ends it, and a socket that never comes still lets the gateway start.
func TestGatewaySocketWaitNeverFailsTheUnit(t *testing.T) {
	if _, err := osexec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	script := socketWaitScript(t)
	if !strings.Contains(script, "seq 1 60") {
		t.Fatalf("the wait is no longer bounded to 60 s: %s", script)
	}
	run := func(t *testing.T, withUnit, withSocket bool) (string, time.Duration) {
		t.Helper()
		home := t.TempDir()
		unitDir := filepath.Join(home, "hermes/.config/systemd/user")
		if err := os.MkdirAll(unitDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if withUnit {
			if err := os.WriteFile(filepath.Join(unitDir, "docker.service"), nil, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		// Short directory: a Unix socket path is limited to about 104 bytes.
		sockDir, err := os.MkdirTemp("/tmp", "gw")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(sockDir) })
		sock := filepath.Join(sockDir, "s")
		if withSocket {
			l, err := net.Listen("unix", sock)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { l.Close() })
		}
		s := strings.ReplaceAll(script, "/home/", home+"/")
		s = strings.ReplaceAll(s, "/run/user/998/docker.sock", sock)
		s = strings.ReplaceAll(s, "seq 1 60", "seq 1 2")
		start := time.Now()
		out, err := osexec.Command("sh", "-c", s).CombinedOutput()
		if err != nil {
			t.Fatalf("the wait failed the unit (unit=%v socket=%v): %v %s", withUnit, withSocket, err, out)
		}
		return string(out), time.Since(start)
	}
	if out, took := run(t, false, false); out != "" || took > time.Second {
		t.Errorf("without rootless docker: waited %v, said %q", took, out)
	}
	if out, took := run(t, true, true); out != "" || took > time.Second {
		t.Errorf("with the socket: waited %v, said %q", took, out)
	}
	if out, took := run(t, true, false); !strings.Contains(out, "still missing") || took < time.Second {
		t.Errorf("socket never comes: waited %v, said %q", took, out)
	}
}

// Hermes 0.22 proves a live gateway from the host's process view (pid file,
// lock, runtime record matched against /proc). A private PID namespace makes
// the gateway record its own PID as 1, so every host-side Hermes command
// (profile delete, create, rename, status) misses the live multiplexer: on the
// lab a profile delete left its identity unsettled and the gateway recreated
// the deleted directory. The connector keeps its own PrivatePIDs= and stays
// non-dumpable, which is what keeps its /proc entries out of reach.
func TestGatewayUnitSharesTheHostProcessView(t *testing.T) {
	for _, p := range []GatewayParams{{DockerEnabled: true, UID: 998}, {DockerEnabled: false}} {
		for _, line := range strings.Split(must(t)(GatewayUnit(p)), "\n") {
			if strings.HasPrefix(line, "PrivatePIDs=") {
				t.Errorf("docker=%v: %q: Hermes cannot prove its live gateway from a private PID namespace", p.DockerEnabled, line)
			}
		}
	}
}

// The connector shares the gateway's uid, and systemd hands a unit's
// credentials to that uid alone: the unsealed device key and the link token sit
// readable under /run/credentials/hermes-connector*.service. A gateway that can
// see that tree defeats the proof of possession, so it is masked, which only
// holds while the gateway loads no credential of its own.
func TestGatewayUnitMasksSystemdCredentials(t *testing.T) {
	for _, p := range []GatewayParams{{DockerEnabled: true, UID: 998}, {DockerEnabled: false}} {
		masked := false
		for _, line := range strings.Split(must(t)(GatewayUnit(p)), "\n") {
			if paths, ok := strings.CutPrefix(line, "InaccessiblePaths="); ok && slices.Contains(strings.Fields(paths), "-/run/credentials") {
				masked = true
			}
			for _, directive := range []string{"LoadCredential", "SetCredential", "ImportCredential"} {
				if strings.HasPrefix(line, directive) {
					t.Errorf("docker=%v: %q: the gateway masks /run/credentials, it cannot also load a credential", p.DockerEnabled, line)
				}
			}
		}
		if !masked {
			t.Errorf("docker=%v: the gateway unit must carry InaccessiblePaths=-/run/credentials: it shares the connector's uid, and systemd credentials are gated by uid alone", p.DockerEnabled)
		}
	}
}

// The leading - of that mask skips a path that does not exist when the unit's
// mount namespace is built, and /run/credentials may not exist yet at a cold
// boot: systemd creates it for the first unit that holds a credential, which
// can be the connector, ordered after the gateway. A root ExecStartPre= creates
// it first. Its only other privileged pre-step is the bounded wait for the
// rootless docker socket, and only when docker is enabled.
func TestGatewayUnitCreatesCredentialsDirectoryBeforeMaskingIt(t *testing.T) {
	const pre = "ExecStartPre=+/bin/mkdir -p -m 0755 /run/credentials"
	const socketWait = "ExecStartPre=+/bin/sh -c 'test -e /home/hermes/.config/systemd/user/docker.service || exit 0;"
	for _, p := range []GatewayParams{{DockerEnabled: true, UID: 998}, {DockerEnabled: false}} {
		found := false
		for _, line := range strings.Split(must(t)(GatewayUnit(p)), "\n") {
			switch {
			case line == pre:
				found = true
			case p.DockerEnabled && strings.HasPrefix(line, socketWait):
			case strings.HasPrefix(line, "ExecStartPre"):
				t.Errorf("docker=%v: %q: the gateway's pre-steps are %q and, with docker, the socket wait", p.DockerEnabled, line, pre)
			}
		}
		if !found {
			t.Errorf("docker=%v: the gateway unit must carry %q: without it the mask is skipped when /run/credentials does not exist at start", p.DockerEnabled, pre)
		}
	}
}

// ipFilterEntry is one address of an IPAddressAllow= or IPAddressDeny= list:
// the spelling in the unit and the prefix it stands for.
type ipFilterEntry struct {
	token  string
	prefix netip.Prefix
}

// ipAddressLists reads the two lists the way systemd accumulates them: every
// line adds its space-separated entries and an empty assignment resets the
// list. The symbolic names are expanded as systemd.resource-control(5)
// defines them.
func ipAddressLists(t *testing.T, name, unit string) (allow, deny []ipFilterEntry) {
	t.Helper()
	symbolic := map[string][]string{
		"any":        {"0.0.0.0/0", "::/0"},
		"localhost":  {"127.0.0.0/8", "::1/128"},
		"link-local": {"169.254.0.0/16", "fe80::/64"},
		"multicast":  {"224.0.0.0/4", "ff00::/8"},
	}
	for _, line := range strings.Split(unit, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || (key != "IPAddressAllow" && key != "IPAddressDeny") {
			continue
		}
		list := &allow
		if key == "IPAddressDeny" {
			list = &deny
		}
		if strings.TrimSpace(value) == "" {
			*list = nil
			continue
		}
		for _, token := range strings.Fields(value) {
			spellings := symbolic[token]
			if spellings == nil {
				spellings = []string{token}
			}
			for _, spelling := range spellings {
				prefix, err := netip.ParsePrefix(spelling)
				if err != nil {
					addr, addrErr := netip.ParseAddr(spelling)
					if addrErr != nil {
						t.Fatalf("%s: %s=%q is not an address systemd accepts", name, key, token)
					}
					prefix = netip.PrefixFrom(addr, addr.BitLen())
				}
				*list = append(*list, ipFilterEntry{token: token, prefix: prefix})
			}
		}
	}
	return allow, deny
}

// egressGranted applies the three rules of systemd.resource-control(5) in
// turn: an address matching IPAddressAllow= is granted, otherwise one matching
// IPAddressDeny= is refused, otherwise it is granted.
func egressGranted(allow, deny []ipFilterEntry, dst netip.Addr) bool {
	matches := func(list []ipFilterEntry) bool {
		for _, e := range list {
			if e.prefix.Contains(dst) {
				return true
			}
		}
		return false
	}
	return matches(allow) || !matches(deny)
}

// filteredUnits renders the five unit variants that carry the metadata deny,
// for a host whose resolvers inside a denied range are the given ones.
func filteredUnits(t *testing.T, resolvers []netip.Addr) []struct{ name, text string } {
	t.Helper()
	return []struct{ name, text string }{
		{"hermes-gateway.service (docker)", must(t)(GatewayUnit(GatewayParams{DockerEnabled: true, UID: 998, EgressAllow: resolvers}))},
		{"hermes-gateway.service (local)", must(t)(GatewayUnit(GatewayParams{DockerEnabled: false, EgressAllow: resolvers}))},
		{"hermes-connector.service", must(t)(ConnectorUnit(998, resolvers))},
		{"hermes-connector@.service", must(t)(ConnectorTemplateUnit(998, resolvers))},
		{"hermes-operator.service", must(t)(OperatorUnit(resolvers))},
	}
}

// Regression: the three units rendered IPAddressAllow=any in front of the
// metadata ranges. systemd reads IPAddressAllow= first (egressGranted), so every
// address, 169.254.169.254 included, matched it and the IPAddressDeny= lines
// never applied. An allow entry that overlaps a denied range reopens it just
// the same: the rule is about every entry, not about the spelling `any`.
func TestMetadataDenyIsNotShadowedByAnAllowList(t *testing.T) {
	for _, u := range filteredUnits(t, nil) {
		allow, deny := ipAddressLists(t, u.name, u.text)
		if len(deny) == 0 {
			t.Errorf("%s: no IPAddressDeny= line, the metadata ranges are not refused", u.name)
			continue
		}
		for _, endpoint := range []string{"169.254.169.254", "fd00:ec2::254"} {
			if egressGranted(allow, deny, netip.MustParseAddr(endpoint)) {
				t.Errorf("%s: %s is granted: an address matching IPAddressAllow= is granted before IPAddressDeny= is read (systemd.resource-control(5))", u.name, endpoint)
			}
		}
		// Everything else is granted by the third rule, loopback included:
		// the filter applies to ingress too, and the connector reaches the
		// gateway on 127.0.0.1.
		for _, other := range []string{"127.0.0.1", "::1", "203.0.113.7", "2001:db8::7"} {
			if !egressGranted(allow, deny, netip.MustParseAddr(other)) {
				t.Errorf("%s: %s is refused, only the metadata ranges may be", u.name, other)
			}
		}
		// No allow entry may open any part of a denied range.
		for _, d := range deny {
			for _, a := range allow {
				if a.prefix.Overlaps(d.prefix) {
					t.Errorf("%s: IPAddressAllow=%s overlaps IPAddressDeny=%s", u.name, a.token, d.token)
				}
			}
		}
	}
}

// GCE and OCI serve DNS on 169.254.169.254, the metadata address itself. A host
// whose /etc/resolv.conf names such a resolver would lose name resolution in
// the three units, and the connector its link, the moment the deny takes
// effect. That one address is allowed, as a single host: the rest of its range,
// the other metadata endpoints and the other address family stay refused.
func TestResolverInsideADeniedRangeStaysReachable(t *testing.T) {
	for _, c := range []struct {
		name      string
		resolvers []string
		refused   []string
	}{
		{"IPv4 link-local resolver", []string{"169.254.169.254"}, []string{"169.254.170.2", "169.254.169.253", "169.254.0.1", "fd00:ec2::254", "fd00:ec2::253"}},
		{"IPv6 resolver", []string{"fd00:ec2::253"}, []string{"fd00:ec2::254", "fd00:ec2::1", "169.254.169.254", "169.254.170.2"}},
		{"both families", []string{"169.254.169.254", "fd00:ec2::253"}, []string{"169.254.170.2", "fd00:ec2::254"}},
	} {
		var resolvers []netip.Addr
		for _, r := range c.resolvers {
			resolvers = append(resolvers, netip.MustParseAddr(r))
		}
		for _, u := range filteredUnits(t, resolvers) {
			allow, deny := ipAddressLists(t, u.name, u.text)
			// The allow list is exactly the resolvers, each a single host.
			if len(allow) != len(resolvers) {
				t.Errorf("%s, %s: %d IPAddressAllow= entries, want one per resolver (%d)", c.name, u.name, len(allow), len(resolvers))
			}
			for _, a := range allow {
				if !a.prefix.IsSingleIP() {
					t.Errorf("%s, %s: IPAddressAllow=%s is not a single host", c.name, u.name, a.token)
				}
			}
			for _, r := range resolvers {
				if !egressGranted(allow, deny, r) {
					t.Errorf("%s, %s: resolver %s is refused, name resolution would fail", c.name, u.name, r)
				}
			}
			for _, refused := range c.refused {
				if egressGranted(allow, deny, netip.MustParseAddr(refused)) {
					t.Errorf("%s, %s: %s is granted, only the resolver may be", c.name, u.name, refused)
				}
			}
			// 169.254.169.254 itself stays refused unless it is the resolver.
			for _, endpoint := range []string{"169.254.169.254", "fd00:ec2::254"} {
				if got, isResolver := egressGranted(allow, deny, netip.MustParseAddr(endpoint)), slices.Contains(resolvers, netip.MustParseAddr(endpoint)); got != isResolver {
					t.Errorf("%s, %s: %s granted = %v, want %v", c.name, u.name, endpoint, got, isResolver)
				}
			}
			for _, other := range []string{"127.0.0.1", "::1", "203.0.113.7", "2001:db8::7"} {
				if !egressGranted(allow, deny, netip.MustParseAddr(other)) {
					t.Errorf("%s, %s: %s is refused, only the metadata ranges may be", c.name, u.name, other)
				}
			}
		}
	}
}

// An allow entry outranks the deny list, so render writes one only for a plain
// address of a denied range. Anything else is refused, never rendered.
func TestRenderRefusesAnExceptionThatIsNotAResolverInsideADeniedRange(t *testing.T) {
	for _, bad := range []netip.Addr{
		netip.MustParseAddr("1.1.1.1"),
		netip.MustParseAddr("127.0.0.53"),
		netip.MustParseAddr("fe80::1"),
		netip.MustParseAddr("::ffff:169.254.169.254"),
		netip.MustParseAddr("fe80::1%eth0"),
		{},
	} {
		resolvers := []netip.Addr{netip.MustParseAddr("169.254.169.254"), bad}
		if _, err := GatewayUnit(GatewayParams{EgressAllow: resolvers}); err == nil {
			t.Errorf("GatewayUnit rendered the exception %v", bad)
		}
		if _, err := ConnectorUnit(998, resolvers); err == nil {
			t.Errorf("ConnectorUnit rendered the exception %v", bad)
		}
		if _, err := ConnectorTemplateUnit(998, resolvers); err == nil {
			t.Errorf("ConnectorTemplateUnit rendered the exception %v", bad)
		}
		if _, err := OperatorUnit(resolvers); err == nil {
			t.Errorf("OperatorUnit rendered the exception %v", bad)
		}
	}
}

func TestRollbackTimerIsFixedAt600s(t *testing.T) {
	s := must(t)(HardeningRollbackTimer())
	if !strings.Contains(s, "OnActiveSec=600s\n") {
		t.Errorf("hardening timer is not 600 s:\n%s", s)
	}
	if !strings.Contains(s, "ConditionPathExists=/var/lib/hermes-") {
		t.Errorf("hardening timer lacks the active-marker condition")
	}
	if s := must(t)(HardeningRollbackService()); !strings.Contains(s, "ExecStart=/usr/local/lib/hermes-setup/edge-setup internal rollback-access\n") {
		t.Errorf("rollback service must exec the installed copy of the binary:\n%s", s)
	}
}

func TestConnectorUnitInvariants(t *testing.T) {
	s := must(t)(ConnectorUnit(998, nil))
	for _, want := range []string{
		"User=hermes\n",
		"LoadCredential=runtime.env:/srv/hermes/data/runtime.env\n",
		"LoadCredential=link.json:/etc/hermes/connector/link.json\n",
		"LoadCredentialEncrypted=device.key:/etc/hermes/connector/device.key.cred\n",
		"ConditionPathExists=/etc/hermes/connector/link.json\n",
		"IPAddressDeny=169.254.0.0/16\n", "IPAddressDeny=fd00:ec2::/64\n",
		"ProtectSystem=strict\n",
		"InaccessiblePaths=/srv/hermes/data\n",
		"InaccessiblePaths=-/run/user/998\n",
		"PrivatePIDs=true\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(s, "Environment=API_SERVER_KEY") || strings.Contains(s, "EnvironmentFile=") {
		t.Error("the connector must not receive the bearer through the environment")
	}
}

func TestOperatorUnitInvariants(t *testing.T) {
	s := must(t)(OperatorUnit(nil))
	for _, want := range []string{
		"RuntimeDirectory=hermes-operator\n",
		"ExecStart=/usr/local/lib/hermes-setup/edge-setup internal operator\n",
		"ReadWritePaths=/srv/hermes/data\n",
		"IPAddressDeny=169.254.0.0/16\n", "IPAddressDeny=fd00:ec2::/64\n",
		"ProtectSystem=strict\n", "NoNewPrivileges=true\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(s, "API_SERVER_KEY") || strings.Contains(s, "EnvironmentFile=") || strings.Contains(s, "LoadCredential=") {
		t.Error("the operator reads the bearer from runtime.env itself; nothing goes through the unit")
	}
	// Root is the default. Spelling it out is not a no-op: with
	// NoNewPrivileges= and the sandbox directives, systemd 257 removes
	// CAP_SETUID from an explicit User= service, and runuser -u hermes dies
	// with "cannot set user id" (seen on Debian 13, kernel 6.12).
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "User=") || strings.HasPrefix(line, "Group=") {
			t.Errorf("%q: the operator must stay root implicitly, an explicit User= loses CAP_SETUID under NoNewPrivileges=", line)
		}
	}
}

// The « restart pending » marker (layout.GatewayRestartMarker) sits in the
// operator's RuntimeDirectory, and `upgrade` always restarts the operator.
// systemd removes a RuntimeDirectory on every stop or restart of its service
// unless RuntimeDirectoryPreserve= says otherwise, so without it a pending
// gateway restart (MCP write, A2A credentials, profile capabilities, changed
// gateway unit directives) vanishes with the next operator restart and the
// console stops saying that the gateway must restart.
func TestOperatorUnitKeepsTheRestartMarkerAcrossOperatorRestarts(t *testing.T) {
	service := map[string]string{}
	section := ""
	for _, line := range strings.Split(must(t)(OperatorUnit(nil)), "\n") {
		switch {
		case strings.HasPrefix(line, "#"): // a comment, never a directive
		case strings.HasPrefix(line, "["):
			section = line
		default:
			if key, value, ok := strings.Cut(line, "="); ok && section == "[Service]" {
				service[key] = value
			}
		}
	}
	if dir, want := filepath.Dir(layout.GatewayRestartMarker), "/run/"+service["RuntimeDirectory"]; dir != want {
		t.Errorf("the marker %s is not inside the [Service] RuntimeDirectory %s", layout.GatewayRestartMarker, want)
	}
	if got := service["RuntimeDirectoryPreserve"]; got != "yes" {
		t.Errorf("[Service] RuntimeDirectoryPreserve = %q, want yes: systemd would delete %s at every operator stop or restart", got, layout.GatewayRestartMarker)
	}
}

func TestSSHDropinInvariants(t *testing.T) {
	s := must(t)(SSHDropin("hermes-admin"))
	for _, want := range []string{"PasswordAuthentication no\n", "PermitRootLogin no\n", "AllowUsers hermes-admin\n", "AuthenticationMethods publickey\n", "MaxAuthTries 3\n", "LoginGraceTime 30\n"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q", want)
		}
	}
}

// The guard is only correct if every rule is deleted before being inserted at
// the head, and if no rule ever reaches a shell.
func TestLoopbackGuardUnitInvariants(t *testing.T) {
	s := must(t)(LoopbackGuardUnit([]string{"-o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable"}))
	for _, want := range []string{
		"Type=oneshot\n", "RemainAfterExit=yes\n",
		"ExecStart=-/usr/sbin/iptables -w -D OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n",
		"ExecStart=/usr/sbin/iptables -w -I OUTPUT 1 -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n",
		"ExecStop=-/usr/sbin/iptables -w -D OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n",
		"CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW\n", "WantedBy=multi-user.target\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(s, "/bin/sh") || strings.Contains(s, "bash") {
		t.Fatal("the guard must never go through a shell")
	}
}

// The automatic upgrade is a root oneshot of the installed binary on a
// randomized, persistent timer: hosts do not all knock on the release at the
// same minute, and a host that was off catches up at boot.
func TestAutoUpgradeUnitsInvariants(t *testing.T) {
	s := must(t)(AutoUpgradeService())
	for _, want := range []string{"Type=oneshot\n", "User=root\n", "ExecStart=/usr/local/lib/hermes-setup/edge-setup upgrade --auto --yes\n"} {
		if !strings.Contains(s, want) {
			t.Errorf("service missing %q", want)
		}
	}
	timer := must(t)(AutoUpgradeTimer())
	for _, want := range []string{"RandomizedDelaySec=1h\n", "Persistent=true\n", "Unit=hermes-setup-upgrade.service\n"} {
		if !strings.Contains(timer, want) {
			t.Errorf("timer missing %q", want)
		}
	}
}

// The template instance differs from the default unit only by what the
// instance name keys: its link, its device key, its state directory and the
// HERMES_CONNECTOR_INSTANCE hint. Every hardening line is shared.
func TestConnectorTemplateUnitKeysPathsByInstance(t *testing.T) {
	s := must(t)(ConnectorTemplateUnit(998, nil))
	for _, want := range []string{
		"ConditionPathExists=/etc/hermes/connector/%i/link.json\n",
		"LoadCredential=link.json:/etc/hermes/connector/%i/link.json\n",
		"LoadCredentialEncrypted=device.key:/etc/hermes/connector/%i/device.key.cred\n",
		"StateDirectory=hermes-connector/%i\n",
		"Environment=HERMES_CONNECTOR_INSTANCE=%i\n",
		"LoadCredential=runtime.env:/srv/hermes/data/runtime.env\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("template unit lacks %q", want)
		}
	}
	base := must(t)(ConnectorUnit(998, nil))
	for _, line := range strings.Split(base, "\n") {
		if strings.Contains(line, "/etc/hermes/connector/") || strings.HasPrefix(line, "StateDirectory=") || strings.HasPrefix(line, "Description=") {
			continue
		}
		if !strings.Contains(s, line+"\n") {
			t.Errorf("template unit dropped %q from the default unit", line)
		}
	}
}
