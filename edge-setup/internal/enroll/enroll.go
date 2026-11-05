// Package enroll validates the one-use credentials consumed by the outbound
// connector handshake. It contains no direct/public enrollment client.
package enroll

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
)

var ticketRe = regexp.MustCompile(`^([0-9a-fA-F-]{36})\.([A-Za-z0-9._~+/=-]{16,256})$`)

// Ticket is a parsed enrollment ticket.
type Ticket struct {
	ID     string
	Secret string
}

// ParseTicket validates `<enrollmentId>.<secret>`.
func ParseTicket(s string) (Ticket, error) {
	m := ticketRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return Ticket{}, errors.New("the ticket must look like <enrollmentId>.<secret> as shown by openedbot")
	}
	return Ticket{ID: m[1], Secret: m[2]}, nil
}

// IsLoopbackHost reports whether a URL host is this machine's own loopback.
// A name other than `localhost` is not resolved: the answer must not depend on
// DNS, which an attacker on the path can steer.
func IsLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ParseOpenedbotURL validates the openedbot API origin: HTTPS only, no path,
// query or credentials.
//
// allowInsecureLoopback is the development escape hatch behind `--insecure-openedbot`:
// it also accepts http:// when the host is loopback, which is how an SSH reverse
// tunnel (`ssh -R 8790:127.0.0.1:8790 <vps>`) puts a workstation in front of
// this host without publishing it. The link then travels inside SSH, never in
// clear text on the wire. Any other http:// origin stays refused, so a plain
// public URL can never be linked by mistake.
func ParseOpenedbotURL(raw string, allowInsecureLoopback bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, err
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, openedbotURLError(allowInsecureLoopback)
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && allowInsecureLoopback && IsLoopbackHost(u.Hostname()):
	default:
		return nil, openedbotURLError(allowInsecureLoopback)
	}
	u.Path = ""
	return u, nil
}

func openedbotURLError(allowInsecureLoopback bool) error {
	if allowInsecureLoopback {
		return errors.New("--openedbot must be an https:// origin, or an http:// loopback origin (localhost, 127.0.0.1, [::1]) with --insecure-openedbot, without path, query or credentials")
	}
	return errors.New("--openedbot must be an https:// origin without path, query or credentials")
}
