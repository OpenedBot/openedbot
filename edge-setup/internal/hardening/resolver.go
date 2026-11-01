package hardening

import (
	"context"
	"fmt"
	"net/netip"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/egress"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// UFW filters the whole host, not one unit. Its `deny out` of the cloud
// metadata ranges (layout.EgressDenyNetworks) therefore also cuts the DNS of a
// host whose resolver sits inside one: GCE and OCI serve DNS on
// 169.254.169.254, the metadata address itself, and systemd-resolved queries
// it from its own, unfiltered unit but through the same firewall. Each such
// nameserver, read from /etc/resolv.conf and from the upstream list behind the
// 127.0.0.53 stub, keeps port 53 (udp and tcp) through an allow rule listed
// above the deny. Every other port of that address, the metadata HTTP endpoint
// included, and the rest of the range stay denied.

// resolverPort and resolverProtocols are all a resolver inside a denied range
// keeps open.
const resolverPort = "53"

var resolverProtocols = []string{"udp", "tcp"}

// metadataResolvers returns the nameservers of the host that sit inside a range
// the firewall denies. A resolver file that exists and cannot be read refuses
// the policy: it cannot be proven to leave DNS alone.
func (h *Hardener) metadataResolvers() ([]netip.Addr, error) {
	resolvers, err := egress.ResolverAllowFromFiles(h.ResolverFiles)
	if err != nil {
		return nil, fmt.Errorf("refusing the firewall: it denies the cloud-metadata ranges for the whole host and the nameservers of this host cannot be established (%w)", err)
	}
	return resolvers, nil
}

// resolverAllowArgs is the ufw command that keeps one protocol of DNS open to a
// resolver. `prepend` lists the rule above every other rule of its family, so
// it sits above the deny of the range even when that deny is already there (a
// replay, a host that carried the deny first). `insert 1` would not do: UFW
// rejects it for an IPv6 rule, which it numbers after the IPv4 ones. UFW skips
// a rule it already holds, so a replay stays idempotent.
func resolverAllowArgs(addr netip.Addr, proto string) []string {
	return []string{"prepend", "allow", "out", "to", addr.String(), "port", resolverPort, "proto", proto, "comment", "Hermes-managed"}
}

// denyMetadataEgress adds the `deny out` rule of every cloud-metadata range,
// each one preceded by the DNS exception of the resolvers inside it. status is
// `ufw status verbose` as read before the first change: a rule already in place
// is not added again, so a replay changes nothing. When an exception cannot be
// added, the deny of its range is not: it would cut name resolution.
func (h *Hardener) denyMetadataEgress(status string, resolvers []netip.Addr, ufw func(args ...string) error) error {
	for _, n := range layout.EgressDenyNetworks {
		for _, r := range egress.Within(resolvers, n) {
			var missing []string
			for _, proto := range resolverProtocols {
				if !ufwAllowsOutAhead(status, r, resolverPort, proto, n) {
					missing = append(missing, proto)
				}
			}
			for _, proto := range missing {
				if err := ufw(resolverAllowArgs(r, proto)...); err != nil {
					return fmt.Errorf("cannot keep the resolver %s reachable above the %s deny; the deny is not added, it would cut name resolution: %w", r, n, err)
				}
			}
			if len(missing) > 0 {
				h.Log("UFW: nameserver %s is inside %s; allowed port %s (%s) to that one address above the deny so name resolution keeps working; every other port of it, the metadata HTTP endpoint included, stays denied",
					r, n, resolverPort, strings.Join(missing, " and "))
			}
		}
		if UFWDeniesOut(status, n) {
			continue
		}
		if err := ufw("deny", "out", "to", n, "comment", "Hermes-managed"); err != nil {
			return err
		}
	}
	return nil
}

// requireResolverException is the firewall preflight, run before any access
// change: when a nameserver of the host sits inside a denied range, UFW must
// accept the rules that keep it reachable, or the policy would cut name
// resolution. `ufw --dry-run` asks UFW itself and changes nothing; with no ufw
// on the host yet there is nobody to ask, and the packaged defaults accept the
// rules.
func (h *Hardener) requireResolverException(ctx context.Context) error {
	resolvers, err := h.metadataResolvers()
	if err != nil {
		return err
	}
	if !h.ufwInstalled() {
		return nil
	}
	for _, n := range layout.EgressDenyNetworks {
		for _, r := range egress.Within(resolvers, n) {
			for _, proto := range resolverProtocols {
				args := append([]string{"--dry-run"}, resolverAllowArgs(r, proto)...)
				res, err := h.ufw(ctx, args...)
				if err != nil {
					return err
				}
				if res.ExitCode != 0 {
					// UFW reports its refusals on stderr; a dry run prints the
					// whole rule file on stdout, which is no reason.
					reason := strings.TrimSpace(res.Stderr)
					if reason == "" {
						reason = fmt.Sprintf("exit %d", res.ExitCode)
					}
					return fmt.Errorf("this host resolves names through %s, inside %s which the firewall denies, and UFW refuses the rule that keeps it reachable (ufw %s: %s); refusing to enable the firewall, it would cut name resolution",
						r, n, strings.Join(args, " "), reason)
				}
			}
		}
	}
	return nil
}

// ufwAllowsOutAhead reports whether `ufw status` lists the ALLOW OUT rule of
// port/proto to addr above the DENY OUT rule of network. UFW matches its rules
// in the order it lists them: an allow below the deny never applies.
func ufwAllowsOutAhead(status string, addr netip.Addr, port, proto, network string) bool {
	allow := ufwOutRule(status, "ALLOW", addr.String()+" "+port+"/"+proto)
	deny := ufwOutRule(status, "DENY", network)
	return allow >= 0 && deny >= 0 && allow < deny
}

// ufwOutRule returns the index of the first line of a `ufw status` output that
// is an OUT rule of action (ALLOW or DENY) whose To column reads to, or -1.
// The columns are split on blanks: UFW pads them to a fixed width and a longer
// To only pushes the others right.
func ufwOutRule(status, action, to string) int {
	for i, line := range strings.Split(status, "\n") {
		f := strings.Fields(line)
		for j := 1; j+1 < len(f); j++ {
			if f[j] != action || f[j+1] != "OUT" {
				continue
			}
			if strings.Join(f[:j], " ") == to {
				return i
			}
			break
		}
	}
	return -1
}

// resolverRule is one DNS exception a resolver needs: protocol proto to addr,
// listed above the deny out of network.
type resolverRule struct {
	addr           netip.Addr
	network, proto string
}

// missingResolverAllows returns the exceptions the resolvers need that status,
// `ufw status verbose`, does not list above the deny out of their range. A
// range whose deny out is not in the policy needs none.
func missingResolverAllows(status string, resolvers []netip.Addr) []resolverRule {
	var missing []resolverRule
	for _, n := range layout.EgressDenyNetworks {
		if !UFWDeniesOut(status, n) {
			continue
		}
		for _, r := range egress.Within(resolvers, n) {
			for _, proto := range resolverProtocols {
				if !ufwAllowsOutAhead(status, r, resolverPort, proto, n) {
					missing = append(missing, resolverRule{r, n, proto})
				}
			}
		}
	}
	return missing
}

// restoreResolverException repairs a firewall whose deny out of a metadata
// range is in place without the exception of a resolver inside it: a policy
// enforced by a build that predates the exception, or a resolver that changed
// since. It prepends what is missing above the deny (nothing missing, nothing
// run, so a replay is idempotent), then re-reads the policy and proves the
// order it left. status is `ufw status verbose` as read before. It reports
// whether it added anything.
//
// Like EnsureLoopbackGuard it runs outside the guarded transaction: it only lets
// DNS through to one address, it cannot lock anyone out.
func (h *Hardener) restoreResolverException(ctx context.Context, status string, resolvers []netip.Addr) (bool, error) {
	if !UFWStatusActive(status) {
		return false, nil
	}
	missing := missingResolverAllows(status, resolvers)
	if len(missing) == 0 {
		return false, nil
	}
	for _, m := range missing {
		if _, err := exec.Must(ctx, h.Runner, ufwCmd(resolverAllowArgs(m.addr, m.proto)...)); err != nil {
			return false, fmt.Errorf("cannot restore the DNS exception of the resolver %s above the %s deny, so name resolution on this host is cut: %w", m.addr, m.network, err)
		}
	}
	for i, m := range missing {
		if i == 0 || missing[i-1].addr != m.addr {
			h.Log("UFW: nameserver %s is inside %s, whose deny out was enforced without the DNS exception; allowed port %s (%s) to that one address above the deny so name resolution keeps working",
				m.addr, m.network, resolverPort, strings.Join(resolverProtocols, " and "))
		}
	}
	after, err := h.ufw(ctx, "status", "verbose")
	if err != nil {
		return true, err
	}
	if still := missingResolverAllows(after.Stdout, resolvers); len(still) > 0 {
		m := still[0]
		return true, fmt.Errorf("the resolver %s lies inside %s, which UFW denies, and UFW lists no rule `allow out to %s port %s proto %s` above that deny after `ufw %s`: name resolution on this host is cut; if that rule sits below the deny, delete it with `ufw delete allow out to %s port %s proto %s` and run again",
			m.addr, m.network, m.addr, resolverPort, m.proto, strings.Join(resolverAllowArgs(m.addr, m.proto), " "), m.addr, resolverPort, m.proto)
	}
	return true, nil
}

// EnsureResolverException restores the DNS exception of every resolver inside a
// denied range on a host whose firewall was enforced without it, as
// EnsureLoopbackGuard installs a guard a build predating it never gave. `up`
// only enforces newly selected features and `upgrade` never ran Enforce, so
// without it such a host keeps a policy that cuts its DNS. It reports whether it
// added anything, and runs no ufw command on a host with no such resolver.
func (h *Hardener) EnsureResolverException(ctx context.Context) (bool, error) {
	resolvers, err := h.metadataResolvers()
	if err != nil || len(resolvers) == 0 {
		return false, err
	}
	status, err := h.ufw(ctx, "status", "verbose")
	if err != nil {
		return false, err
	}
	return h.restoreResolverException(ctx, status.Stdout, resolvers)
}

// ufwCmd is the ufw command line, in the environment every ufw call runs in.
func ufwCmd(args ...string) exec.Cmd {
	return exec.Cmd{Path: "/usr/sbin/ufw", Args: args, Env: []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}}
}
