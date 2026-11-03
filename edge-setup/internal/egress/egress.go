// Package egress carries the one exception the cloud-metadata deny needs.
//
// The gateway, connector and operator units refuse layout.EgressDenyNetworks
// with IPAddressDeny= and carry no IPAddressAllow= over them: systemd grants
// an address matching the allow list before it reads the deny list
// (systemd.resource-control(5)). But GCE and OCI serve DNS on 169.254.169.254,
// the metadata address itself. On a host whose /etc/resolv.conf names such a
// resolver, the deny would cut name resolution in those units the moment it
// takes effect, and the connector would lose its link. The units therefore
// allow that one address, as a single host, and nothing else of the range. A
// stub resolver such as systemd-resolved's 127.0.0.53 lies outside the ranges
// (the daemon runs in its own, unfiltered unit) and needs no exception.
//
// UFW (hardening, with --firewall) denies the same ranges for the whole host,
// the daemon's own upstream queries included, so the stub gives no shelter
// there: the upstreams it forwards to, which systemd-resolved lists in
// layout.ResolvedResolvConf, are the resolvers to keep reachable
// (ResolverAllowFromFiles), on port 53 only.
package egress

import (
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"os"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// deniedRange returns the layout.EgressDenyNetworks range that holds addr.
func deniedRange(addr netip.Addr) (netip.Prefix, bool) {
	for _, network := range layout.EgressDenyNetworks {
		if prefix, err := netip.ParsePrefix(network); err == nil && prefix.Contains(addr) {
			return prefix, true
		}
	}
	return netip.Prefix{}, false
}

// Denied reports whether addr lies inside a range the units refuse.
func Denied(addr netip.Addr) bool {
	_, ok := deniedRange(addr)
	return ok
}

// Nameservers returns the addresses of the nameserver lines of a resolv.conf,
// in order. Every line counts, even past the three that the C library and
// Go's resolver read: allowing one more resolver the host itself lists costs
// one more host address, missing one costs a unit its name resolution. A line
// that is not a nameserver, or whose address does not parse, is skipped; a
// zone is dropped and an IPv4-mapped IPv6 address becomes its IPv4 form.
func Nameservers(resolvConf string) []netip.Addr {
	var out []netip.Addr
	for _, line := range strings.Split(resolvConf, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}
		addr, err := netip.ParseAddr(fields[1])
		if err != nil {
			continue
		}
		out = append(out, addr.WithZone("").Unmap())
	}
	return out
}

// ResolverAllow keeps the nameservers that sit inside a denied range, each
// once and in order. These are the only addresses of those ranges a unit may
// allow.
func ResolverAllow(nameservers []netip.Addr) []netip.Addr {
	var out []netip.Addr
	seen := map[netip.Addr]bool{}
	for _, addr := range nameservers {
		if !Denied(addr) || seen[addr] {
			continue
		}
		seen[addr] = true
		out = append(out, addr)
	}
	return out
}

// readNameservers returns the nameservers of the resolv.conf at path. A missing
// file names none; any other read error is returned.
func readNameservers(path string) ([]netip.Addr, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return Nameservers(string(data)), nil
}

// ResolverAllowFromFiles returns ResolverAllow of the nameservers named by
// every file of paths, in order, each address once. A missing file names none.
// One that exists and cannot be read fails the call: the caller is the
// host-wide firewall, which must not deny a range it cannot prove leaves the
// host's resolver alone.
func ResolverAllowFromFiles(paths []string) ([]netip.Addr, error) {
	var nameservers []netip.Addr
	for _, path := range paths {
		found, err := readNameservers(path)
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %w", path, err)
		}
		nameservers = append(nameservers, found...)
	}
	return ResolverAllow(nameservers), nil
}

// Within returns the addrs that lie inside network (one of
// layout.EgressDenyNetworks), in order.
func Within(addrs []netip.Addr, network string) []netip.Addr {
	prefix, err := netip.ParsePrefix(network)
	if err != nil {
		return nil
	}
	var out []netip.Addr
	for _, addr := range addrs {
		if prefix.Contains(addr) {
			out = append(out, addr)
		}
	}
	return out
}

// ResolverAllowFrom reads the resolv.conf at path (layout.ResolvConf) and
// returns ResolverAllow of its nameservers. Each exception is logged against
// scope, the unit or units about to carry it. A missing file yields none, as
// does one that cannot be read (logged): the host then has no resolver to
// protect, or none this tool can see.
func ResolverAllowFrom(path, scope string, log func(string, ...any)) []netip.Addr {
	if log == nil {
		log = func(string, ...any) {}
	}
	nameservers, err := readNameservers(path)
	if err != nil {
		log("%s: cannot read %s (%v): no resolver exception is rendered", scope, path, err)
		return nil
	}
	allow := ResolverAllow(nameservers)
	for _, addr := range allow {
		denied, _ := deniedRange(addr)
		log("%s: nameserver %s is inside %s; allowing that one address (IPAddressAllow=%s) so name resolution keeps working. Metadata stays reachable through it where it is also the metadata server (GCE, OCI): the systemd-resolved stub (127.0.0.53) as nameserver needs no exception",
			scope, addr, denied, netip.PrefixFrom(addr, addr.BitLen()))
	}
	return allow
}
