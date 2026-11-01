package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

// LinkFile is an instance's private enrollment credential. Linux keeps it
// root-owned and hands a copy to systemd; macOS keeps it user-owned.
type LinkFile struct {
	Schema    int    `json:"schema"`
	OHB       string `json:"ohb"`
	WSURL     string `json:"ws_url"`
	RuntimeID string `json:"runtime_id"`
	LinkToken string `json:"link_token"`
	LinkedAt  string `json:"linked_at"`
	// The link context openedbot declared at enrollment (link.context):
	// display data for alerts and status, refreshed by the daemon in its
	// state directory (linkContextFile) since link.json is a read-only
	// credential for it.
	Environment  string                      `json:"ohb_environment,omitempty"`
	Organization *connector.LinkOrganization `json:"organization,omitempty"`
	Owner        *connector.LinkOwner        `json:"owner,omitempty"`
}

// linkContext is what link.json (enrollment) or the overlay (daemon) holds
// of the last link.context, as a connector value.
func (lf LinkFile) linkContext() connector.LinkContext {
	lc := connector.LinkContext{Environment: lf.Environment, OHB: lf.OHB}
	if lf.Organization != nil {
		lc.Organization = *lf.Organization
	}
	if lf.Owner != nil {
		lc.Owner = *lf.Owner
	}
	return lc
}

// linkContextFile is the daemon-owned overlay of the link context, next to
// the rotated token in StateDirectory: the unit runs under
// ProtectSystem=strict and reads link.json as a read-only credential, so the
// context openedbot sends on every session lands here, best-effort. The
// runtime id keeps an old overlay from surviving a fresh enrollment.
//
// Limits holds the bounds the last link.context announced. Unlike the rest of
// the file it is not display data: the daemon reads it back before its first
// session, so the first hello after a restart already honors the bound instead
// of waiting for the next link.context. A file without it (written by an older
// daemon, or after an API that announced none) leaves the default bound.
type linkContextFile struct {
	Schema       int                         `json:"schema"`
	RuntimeID    string                      `json:"runtime_id"`
	Environment  string                      `json:"ohb_environment"`
	OHB          string                      `json:"ohb"`
	Organization *connector.LinkOrganization `json:"organization,omitempty"`
	Owner        *connector.LinkOwner        `json:"owner,omitempty"`
	Limits       *linkContextLimits          `json:"limits,omitempty"`
	ReceivedAt   string                      `json:"received_at"`
}

type linkContextLimits struct {
	Features int `json:"features"`
}

func loadLinkContext(path, runtimeID string) (connector.LinkContext, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return connector.LinkContext{}, false
	}
	var f linkContextFile
	if err := json.Unmarshal(data, &f); err != nil || f.Schema != 1 || f.RuntimeID != runtimeID || f.Environment == "" {
		return connector.LinkContext{}, false
	}
	lc := LinkFile{OHB: f.OHB, Environment: f.Environment, Organization: f.Organization, Owner: f.Owner}.linkContext()
	if f.Limits != nil && f.Limits.Features > 0 {
		lc.FeatureLimit = f.Limits.Features
	}
	return lc, true
}

// restoreLinkContext is what the daemon knows of the link before any frame:
// link.json (the enrollment), then the overlay of a previous session. The
// feature bound that session learned goes to the client, so the very first
// hello of this process already honors it.
func restoreLinkContext(c *connector.Client, contextPath string, lf LinkFile) connector.LinkContext {
	if stored, ok := loadLinkContext(contextPath, lf.RuntimeID); ok {
		c.SetFeatureBound(stored.FeatureLimit)
		return stored
	}
	return lf.linkContext()
}

func persistLinkContext(path, runtimeID string, lc connector.LinkContext, now time.Time) error {
	f := linkContextFile{Schema: 1, RuntimeID: runtimeID, Environment: lc.Environment, OHB: lc.OHB, ReceivedAt: now.UTC().Format(time.RFC3339)}
	if lc.Organization != (connector.LinkOrganization{}) {
		org := lc.Organization
		f.Organization = &org
	}
	if lc.Owner != (connector.LinkOwner{}) {
		owner := lc.Owner
		f.Owner = &owner
	}
	if lc.FeatureLimit > 0 {
		f.Limits = &linkContextLimits{Features: lc.FeatureLimit}
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, append(data, '\n'), 0o600, fsx.Current())
}

// alertContextOf is what the Discord card names for this instance.
func alertContextOf(inst layout.ConnectorInstance, lc connector.LinkContext) connector.AlertContext {
	return connector.AlertContext{Environment: lc.Environment, Instance: inst.Label(), OHB: lc.OHB, OwnerEmail: lc.Owner.Email, Organization: lc.Organization.Name}
}

// rotatedLinkCredential is the connector-owned durable overlay for the
// root-owned enrollment file. systemd exposes LoadCredential copies as
// read-only, while StateDirectory is writable by the connector unit. The
// runtime id prevents an old overlay from surviving a fresh enrollment.
type rotatedLinkCredential struct {
	Schema    int    `json:"schema"`
	RuntimeID string `json:"runtime_id"`
	LinkToken string `json:"link_token"`
	RotatedAt string `json:"rotated_at"`
}

func loadRotatedLinkToken(path, runtimeID string) (string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var rotated rotatedLinkCredential
	if err := json.Unmarshal(data, &rotated); err != nil {
		return "", fmt.Errorf("decode rotated link credential: %w", err)
	}
	if rotated.Schema != 1 || rotated.RuntimeID == "" || rotated.LinkToken == "" {
		return "", errors.New("rotated link credential is invalid")
	}
	if rotated.RuntimeID != runtimeID {
		return "", nil
	}
	return rotated.LinkToken, nil
}

func persistRotatedLinkToken(path, runtimeID, linkToken string, now time.Time) error {
	rotated := rotatedLinkCredential{
		Schema: 1, RuntimeID: runtimeID, LinkToken: linkToken,
		RotatedAt: now.UTC().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(rotated, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, append(data, '\n'), 0o600, fsx.Current())
}

// movedLinkOrigin is the connector-owned overlay of link.json's ws_url,
// written when openedbot announces a new origin under the same domain
// (connector.MovedWSURL). Like the rotated token, it lives in the writable
// StateDirectory and names its runtime so a fresh enrollment ignores it.
type movedLinkOrigin struct {
	Schema    int    `json:"schema"`
	RuntimeID string `json:"runtime_id"`
	WSURL     string `json:"ws_url"`
	MovedAt   string `json:"moved_at"`
}

// loadMovedLinkOrigin returns the overlay endpoint for runtimeID, or "" when
// there is none. An overlay that fails validateWSURL is refused like a bad
// link.json, never silently dialled.
func loadMovedLinkOrigin(path, runtimeID string) (string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var moved movedLinkOrigin
	if err := json.Unmarshal(data, &moved); err != nil {
		return "", fmt.Errorf("decode moved link origin: %w", err)
	}
	if moved.Schema != 1 || moved.RuntimeID == "" || moved.WSURL == "" {
		return "", errors.New("moved link origin is invalid")
	}
	if moved.RuntimeID != runtimeID {
		return "", nil
	}
	if err := validateWSURL(moved.WSURL); err != nil {
		return "", fmt.Errorf("moved link origin: %w", err)
	}
	return moved.WSURL, nil
}

func persistMovedLinkOrigin(path, runtimeID, wsURL string, now time.Time) error {
	if err := validateWSURL(wsURL); err != nil {
		return err
	}
	data, err := json.MarshalIndent(movedLinkOrigin{
		Schema: 1, RuntimeID: runtimeID, WSURL: wsURL, MovedAt: now.UTC().Format(time.RFC3339),
	}, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, append(data, '\n'), 0o600, fsx.Current())
}

// wsURLOf derives the link endpoint from the origin ParseOHBURL accepted, so
// an https origin stays wss and the loopback development origin stays ws.
func wsURLOf(ohb string) string {
	if rest, ok := strings.CutPrefix(ohb, "http://"); ok {
		return "ws://" + rest + "/api/runtime-links/ws"
	}
	return "wss://" + strings.TrimPrefix(ohb, "https://") + "/api/runtime-links/ws"
}

// wsPath is the only broker path a link may target.
const wsPath = "/api/runtime-links/ws"

// validateWSURL re-applies the enrollment contract to the WebSocket URL read
// from link.json at every daemon start: wss:// toward any host, ws:// only
// toward a loopback host (the development SSH tunnel). link.json is root-only,
// but a file edited by hand or restored from elsewhere must not be able to
// downgrade the link to plaintext toward a public origin.
func validateWSURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("ws_url is not a URL: %v", err)
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("ws_url must carry a host and neither credentials, query nor fragment")
	}
	if u.Path != wsPath {
		return fmt.Errorf("ws_url path must be %s", wsPath)
	}
	switch u.Scheme {
	case "wss":
		return nil
	case "ws":
		if enroll.IsLoopbackHost(u.Hostname()) {
			return nil
		}
		return errors.New("ws:// is only accepted toward a loopback host; a public origin must use wss://")
	default:
		return fmt.Errorf("ws_url scheme %q is not wss:// (or ws:// on loopback)", u.Scheme)
	}
}

// DefaultOHBOrigin is the production openedbot origin `link` targets when
// --ohb is omitted. Development and self-hosted origins are always explicit.
const DefaultOHBOrigin = "https://link.openedbot.app"

// linkOrigin is the origin `link` enrolls against: the --ohb value, or the
// production default when the flag is absent or blank.
func linkOrigin(flagValue string) string {
	if strings.TrimSpace(flagValue) == "" {
		return DefaultOHBOrigin
	}
	return flagValue
}

func runLink(env cli.Env, args []string) int {
	fs := newFlagSet("link", env)
	ohb := fs.String("ohb", "", "openedbot origin, https://… (default "+DefaultOHBOrigin+")")
	ticketFile := fs.String("ticket-file", "", "0600 file holding the enrollment ticket (default: stdin, or a prompt without echo)")
	insecureOHB := fs.Bool("insecure-ohb", false, "development only: also accept an http:// loopback origin, reached through an SSH reverse tunnel (never a public origin)")
	rekey := fs.Bool("rekey", false, "regenerate the device key of an already linked runtime, without a ticket; the new public key is presented to openedbot on one session")
	name := fs.String("name", "", "named connector instance (^[a-z][a-z0-9-]{0,31}$): its own link, device key and native service, next to the default link; e.g. --name dev for a development openedbot")
	yes := fs.Bool("yes", false, "confirm the mutation")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	inst, err := layout.ParseConnectorInstance(*name)
	if err != nil {
		return fail(env, cli.ExitUsage, "%v", err)
	}
	if *rekey {
		if fs.NArg() != 0 || *ohb != "" || *ticketFile != "" {
			return fail(env, cli.ExitUsage, "--rekey takes no ticket and no --ohb: it reuses the link already persisted on this host")
		}
		if !*yes {
			return fail(env, cli.ExitRefused, "link --rekey replaces the device key and re-presents it to openedbot; add --yes (nothing was changed)")
		}
		return runLinkRekey(env, inst)
	}
	if fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "the ticket is a secret: it never travels in argv. Run `edge-setup link --ohb https://… --yes` and paste it at the hidden prompt, or use --ticket-file <0600 file>")
	}
	if !*yes {
		return fail(env, cli.ExitRefused, "link opens an outbound connection to openedbot and stores a link token; add --yes (nothing was changed)")
	}
	// The origin is validated before the root gate: a typo is a usage error,
	// and reading it costs nothing. Nothing is mutated either way.
	u, err := enroll.ParseOHBURL(linkOrigin(*ohb), *insecureOHB)
	if err != nil {
		return fail(env, cli.ExitUsage, "%v", err)
	}
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	// `link` is an updateOrCreate: it writes the link of the instance it
	// targets, whatever was there. There is no flag to unlock, because there
	// is nothing here a flag could protect. The native owner can rewrite
	// link.json by hand anyway; a refusal would only be a
	// speed bump worn by the one operator who has a legitimate reason to
	// switch. The real boundaries are elsewhere and unchanged: an enrollment
	// needs a ticket issued by an authenticated owner in openedbot, an
	// http:// origin is accepted on the loopback only and only behind
	// --insecure-ohb, and `reset` is what removes the runtime for good.
	//
	st, err := loadConnectorState()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if st == nil || st.Mode != state.ModeConnector {
		return fail(env, cli.ExitRefused, "this host is not configured for connector mode; run `edge-setup up` first")
	}
	service, err := connectorService(inst)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	installed, err := service.Installed()
	if err != nil {
		return fail(env, cli.ExitRefused, "connector service: %v (nothing was changed)", err)
	}
	if !installed {
		if runtime.GOOS != "darwin" {
			return fail(env, cli.ExitRefused, "the connector service (%s) is not installed; run `edge-setup up` first", service.Name())
		}
		// LaunchAgents have one plist per instance rather than a shared systemd
		// template. The installed host configuration and binary were checked
		// first; preparing this definition does not bootstrap a process.
		if err := refreshConnectorDefinition(context.Background(), inst, func(string, ...any) {}); err != nil {
			return fail(env, cli.ExitFailure, "prepare connector service: %v (the ticket was not spent)", err)
		}
		installed, err = service.Installed()
		if err != nil || !installed {
			return fail(env, cli.ExitFailure, "connector service definition could not be verified (the ticket was not spent)")
		}
	}
	// What is owed instead is the truth, before the ticket is spent: which
	// origin this host leaves, and which runtime goes stale there.
	previous, switching := linkTakeover(inst, u.String())
	switch {
	case switching:
		printf(env.Stdout, "%s", env.Color.Yellow(fmt.Sprintf("replacing the link to %s (runtime %s): that openedbot keeps a runtime this host will never dial again, remove it there", previous.OHB, previous.RuntimeID)))
	case previous != nil:
		printf(env.Stdout, "re-linking to %s: this ticket issues a new runtime, replacing %s", previous.OHB, previous.RuntimeID)
	}
	if u.Scheme == "http" {
		printf(env.Stdout, "%s", env.Color.Yellow("development link: "+u.String()+" is plain HTTP on this host's loopback. Keep the SSH reverse tunnel open from the workstation (make link-dev-up HOST=user@vps, closed by make link-dev-down). The link dials that port now, and the connector reconnects to it and stops when the tunnel closes."))
	}
	raw, err := readSecret(*ticketFile, "enrollment ticket", "--ticket-file", "enrollment ticket for "+u.Host+" (not echoed): ")
	if err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	ticket, err := enroll.ParseTicket(raw)
	if err != nil {
		return fail(env, cli.ExitUsage, "%v", err)
	}
	token, err := connectorGatewayToken()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	ctx, cancelTimeout := context.WithTimeout(ctx, 2*time.Minute)
	defer cancelTimeout()
	if err := preflightDeviceKey(ctx, inst); err != nil {
		return fail(env, cli.ExitRefused, "device key storage: %v (the ticket was not spent)", err)
	}
	// A previous link of this instance must not compete with the enrollment
	// handshake; the other instances keep running.
	if err := service.Stop(ctx); err != nil {
		return fail(env, cli.ExitFailure, "stop previous connector: %v (the ticket was not spent)", err)
	}
	c := connector.New(wsURLOf(u.String()), connector.Auth{EnrollmentTicket: ticket.ID + "." + ticket.Secret}, "http://127.0.0.1:8642", token, nil)
	c.Agent = "edge-setup/" + env.Version
	c.HermesVersion = pins.HermesVersion
	c.Logf = func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) }
	// A fresh device key per enrollment: hello presents its public half, the
	// seed is sealed only once openedbot has issued the link.
	deviceKey, err := enroll.GenerateDeviceKey()
	if err != nil {
		return fail(env, cli.ExitFailure, "device key: %v", err)
	}
	c.DeviceKey = deviceKey
	issued := false
	// link.context precedes link.issued on the wire: the enrollment, root at
	// the console, is the one writer of link.json and records it there.
	var received connector.LinkContext
	c.OnLinkContext = func(lc connector.LinkContext) error {
		received = lc
		return nil
	}
	c.OnLinkIssued = func(runtimeID, linkToken string) error {
		lf := LinkFile{Schema: 1, OHB: u.String(), WSURL: wsURLOf(u.String()), RuntimeID: runtimeID, LinkToken: linkToken, LinkedAt: time.Now().UTC().Format(time.RFC3339)}
		if received.Environment != "" {
			lf.Environment = received.Environment
			if received.Organization != (connector.LinkOrganization{}) {
				org := received.Organization
				lf.Organization = &org
			}
			if received.Owner != (connector.LinkOwner{}) {
				owner := received.Owner
				lf.Owner = &owner
			}
		}
		data, err := json.MarshalIndent(lf, "", "  ")
		if err != nil {
			return err
		}
		if err := fsx.EnsureDir(inst.DirUnder(connectorRoot), 0o700, connectorOwner); err != nil {
			return err
		}
		if err := persistConnectorRuntimeCredential(inst, token); err != nil {
			return err
		}
		if _, err := sealDeviceKey(ctx, runner, inst, deviceKey); err != nil {
			return err
		}
		if err := fsx.WriteAtomic(linkPathOf(inst), append(data, '\n'), 0o600, connectorOwner); err != nil {
			return err
		}
		issued = true
		return nil
	}
	printf(env.Stdout, "linking with %s (the ticket is used once; the gateway bearer stays on this host)", u.Host)
	if err := c.Session(ctx); err != nil {
		return fail(env, cli.ExitFailure, "link: %v", err)
	}
	if !issued {
		return fail(env, cli.ExitFailure, "link: openedbot closed the handshake without issuing a link")
	}
	if switching {
		// The daemon-owned overlays of the link we just left are keyed by the
		// old runtime id, so they are already inert; removing them keeps
		// `status` from naming an openedbot this host no longer dials.
		for _, name := range []string{"link-token.json", "link-context.json", "link-origin.json"} {
			_ = os.Remove(filepath.Join(stateDirOf(inst), name))
		}
	}
	// A new link retires a stop on refusals: the unit starts clean.
	if err := clearLinkRefusal(stateDirOf(inst)); err != nil {
		return fail(env, cli.ExitFailure, "link was enrolled but its refusal marker could not be cleared; the connector was not started")
	}
	printf(env.Stdout, "link credentials stored; starting %s", service.Name())
	// EnableNow already starts the unit after the old connector was stopped
	// before enrollment. A second restart here made a successful enrollment
	// look hung and invited Ctrl-C while systemctl was waiting for the service.
	if err := service.Start(ctx); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	printf(env.Stdout, "linked ✓  %s started; openedbot reaches the gateway through the outbound link only", service.Name())
	if runtime.GOOS != "darwin" {
		printAutoUpgradeHint(env)
	}
	return cli.ExitOK
}

// runLinkRekey is `link --rekey --yes`: a new device key, sealed, then one
// session whose hello presents its public half so openedbot replaces the
// registered key. This is the one moment a public key is accepted without a
// prior proof of possession, hence the native owner and --yes; check the
// runtime's link journal in openedbot afterwards.
func runLinkRekey(env cli.Env, inst layout.ConnectorInstance) int {
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	lf, err := readLinkFile(inst)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if lf == nil {
		if inst.IsDefault() {
			return fail(env, cli.ExitRefused, "this host is not linked (%s absent); run `edge-setup link --ohb https://… --yes` with a ticket", linkPathOf(inst))
		}
		return fail(env, cli.ExitRefused, "instance %s is not linked (%s absent); run `edge-setup link --ohb https://… --name %s --yes` with a ticket", inst.Label(), linkPathOf(inst), inst.Label())
	}
	if err := validateWSURL(lf.WSURL); err != nil {
		return fail(env, cli.ExitRefused, "link.json: %v (nothing was changed)", err)
	}
	if rotated, err := loadRotatedLinkToken(filepath.Join(stateDirOf(inst), "link-token.json"), lf.RuntimeID); err != nil {
		return fail(env, cli.ExitFailure, "rotated link credential: %v", err)
	} else if rotated != "" {
		lf.LinkToken = rotated
	}
	if moved, err := loadMovedLinkOrigin(filepath.Join(stateDirOf(inst), "link-origin.json"), lf.RuntimeID); err != nil {
		return fail(env, cli.ExitFailure, "%v (nothing was changed)", err)
	} else if moved != "" {
		lf.WSURL = moved
	}
	token, err := connectorGatewayToken()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	ctx, cancelTimeout := context.WithTimeout(ctx, 2*time.Minute)
	defer cancelTimeout()
	if err := preflightDeviceKey(ctx, inst); err != nil {
		return fail(env, cli.ExitRefused, "device key storage: %v (the device key was not replaced)", err)
	}
	service, err := connectorService(inst)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	// The running link must not race the session that presents the new key.
	if err := service.Stop(ctx); err != nil {
		return fail(env, cli.ExitFailure, "stop previous connector: %v (the device key was not replaced)", err)
	}
	log := func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) }
	deviceKey, err := newDeviceKey(ctx, runner, inst, log)
	if err != nil {
		return fail(env, cli.ExitFailure, "link --rekey: %v", err)
	}
	c := connector.New(lf.WSURL, connector.Auth{RuntimeID: lf.RuntimeID, LinkToken: lf.LinkToken}, "http://127.0.0.1:8642", token, nil)
	c.Agent = "edge-setup/" + env.Version
	c.HermesVersion = pins.HermesVersion
	c.Logf = log
	c.DeviceKey = deviceKey
	printf(env.Stdout, "presenting the new device key to openedbot on one session")
	if err := c.Rekey(ctx); err != nil {
		return fail(env, cli.ExitFailure, "link --rekey: %v (the stored device key was replaced; run --rekey again once openedbot is reachable)", err)
	}
	if err := clearLinkRefusal(stateDirOf(inst)); err != nil {
		return fail(env, cli.ExitFailure, "link was rekeyed but its refusal marker could not be cleared; the connector was not started")
	}
	if err := refreshConnectorDefinition(ctx, inst, func(f string, a ...any) { printf(env.Stdout, "  "+f, a...) }); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if err := service.Restart(ctx); err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	printf(env.Stdout, "rekeyed ✓  %s restarted with the new device key; check the runtime's link journal in openedbot", inst.Unit())
	return cli.ExitOK
}

// runConnectorDaemon is `internal connector`: it reads the bearer, link
// credential and device identity through the native supervisor's setup.
func clearLinkRefusal(stateDir string) error {
	err := os.Remove(filepath.Join(stateDir, linkRefusedMarker))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func runConnectorDaemon(env cli.Env) int {
	if runtime.GOOS == "darwin" {
		if code := prepareConnectorHost(env); code != 0 {
			return code
		}
	}
	credDir := os.Getenv("CREDENTIALS_DIRECTORY")
	if credDir == "" {
		return fail(env, cli.ExitRefused, "internal connector requires its supervisor-provided credentials directory (no CREDENTIALS_DIRECTORY)")
	}
	// systemd sets STATE_DIRECTORY from the unit (StateDirectory=, keyed by
	// %i for a template instance); the instance hint only serves the fallback,
	// so two instances never share a journal, a spool or an audit file.
	inst, err := layout.ParseConnectorInstance(os.Getenv("HERMES_CONNECTOR_INSTANCE"))
	if err != nil {
		return fail(env, cli.ExitRefused, "HERMES_CONNECTOR_INSTANCE: %v", err)
	}
	stateDir := os.Getenv("STATE_DIRECTORY")
	if stateDir == "" {
		stateDir = stateDirOf(inst)
	}
	if runtime.GOOS == "darwin" {
		if credDir != inst.DirUnder(connectorRoot) || stateDir != stateDirOf(inst) {
			return fail(env, cli.ExitRefused, "macOS connector credential and state paths must belong to this instance")
		}
		if fsx.Exists(filepath.Join(stateDir, linkRefusedMarker)) {
			return fail(env, cli.ExitLinkRefused, "this connector was refused; pair it again before starting it")
		}
		for _, name := range []string{"runtime.env", "link.json"} {
			present, err := fsx.RequireRegular(filepath.Join(credDir, name), 0o600, connectorOwner)
			if err != nil || !present {
				return fail(env, cli.ExitRefused, "macOS connector requires private, user-owned %s", name)
			}
		}
	}
	envData, err := os.ReadFile(filepath.Join(credDir, "runtime.env"))
	if err != nil {
		return fail(env, cli.ExitFailure, "runtime.env credential: %v", err)
	}
	token := hermes.ReadToken(string(envData))
	if token == "" {
		return fail(env, cli.ExitFailure, "runtime.env credential carries no API_SERVER_KEY")
	}
	linkData, err := os.ReadFile(filepath.Join(credDir, "link.json"))
	if err != nil {
		return fail(env, cli.ExitFailure, "link.json credential: %v", err)
	}
	var lf LinkFile
	if err := json.Unmarshal(linkData, &lf); err != nil || lf.Schema != 1 || lf.RuntimeID == "" || lf.LinkToken == "" || lf.WSURL == "" {
		return fail(env, cli.ExitFailure, "link.json is invalid; run `edge-setup link` again")
	}
	if err := validateWSURL(lf.WSURL); err != nil {
		return fail(env, cli.ExitRefused, "link.json: %v (nothing was started)", err)
	}
	// The native store supplies the existing device identity. A link without
	// an accessible key cannot prove possession and does not start.
	deviceKey, err := loadInstanceDeviceKey(context.Background(), inst, credDir)
	if err != nil {
		return fail(env, cli.ExitRefused, "%v (nothing was started)", err)
	}
	rotatedPath := filepath.Join(stateDir, "link-token.json")
	rotatedToken, err := loadRotatedLinkToken(rotatedPath, lf.RuntimeID)
	if err != nil {
		return fail(env, cli.ExitFailure, "rotated link credential: %v", err)
	}
	if rotatedToken != "" {
		lf.LinkToken = rotatedToken
	}
	originPath := filepath.Join(stateDir, "link-origin.json")
	movedOrigin, err := loadMovedLinkOrigin(originPath, lf.RuntimeID)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v (nothing was started)", err)
	}
	if movedOrigin != "" {
		lf.WSURL = movedOrigin
	}
	journal, err := connector.NewJournal(filepath.Join(stateDir, "runs"))
	if err != nil {
		return fail(env, cli.ExitFailure, "journal: %v", err)
	}
	c := connector.New(lf.WSURL, connector.Auth{RuntimeID: lf.RuntimeID, LinkToken: lf.LinkToken}, "http://127.0.0.1:8642", token, journal)
	operatorSocket, err := connectorOperatorSocket()
	if err != nil {
		return fail(env, cli.ExitRefused, "operator socket: %v", err)
	}
	c.OperatorSocket = operatorSocket
	c.Agent = "edge-setup/" + env.Version
	c.HermesVersion = pins.HermesVersion
	c.Logf = func(f string, a ...any) { printf(env.Stderr, f, a...) }
	c.DeviceKey = deviceKey
	if diagnostics, diagnosticErr := connector.NewRuntimeDiagnosticSpool(filepath.Join(stateDir, "diagnostics"), lf.RuntimeID, lf.WSURL); diagnosticErr == nil {
		c.Diagnostics = diagnostics
	} else {
		c.Logf("diagnostics disabled: local spool could not be opened")
	}
	if os.Getenv("HERMES_CONNECTOR_CREATION_AUDIT") == "1" {
		audit, auditErr := connector.NewCreationAudit(filepath.Join(stateDir, "creation-audit"), lf.RuntimeID, lf.WSURL)
		if auditErr != nil {
			return fail(env, cli.ExitFailure, "creation audit could not be opened")
		}
		c.CreationAudit = audit
		defer audit.Close()
	}
	c.OnOriginMoved = func(wsURL string) error {
		return persistMovedLinkOrigin(originPath, lf.RuntimeID, wsURL, time.Now())
	}
	c.OnLinkRotated = func(runtimeID, linkToken string) error {
		if err := persistRotatedLinkToken(rotatedPath, runtimeID, linkToken, time.Now()); err != nil {
			return err
		}
		printf(env.Stderr, "link token rotated and persisted")
		return nil
	}
	// The context known before any frame: link.json (enrollment), then the
	// overlay of a previous session. An alert raised while openedbot is
	// unreachable: the case alerts exist for it and still names it.
	contextPath := filepath.Join(stateDir, "link-context.json")
	linkContext := restoreLinkContext(c, contextPath, lf)
	var alerts *connector.Alerts
	c.OnLinkContext = func(lc connector.LinkContext) error {
		if alerts != nil {
			alerts.SetContext(alertContextOf(inst, lc))
		}
		if err := writeLinkAdmitted(stateDir, admittedAgentMarker(c.Agent), time.Now()); err != nil {
			c.Logf("admission marker not written: %v", err)
		}
		return persistLinkContext(contextPath, lf.RuntimeID, lc, time.Now())
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = journal.Sweep(time.Now())
			}
		}
	}()
	// Optional systemd credential installed by the host owner, never by the relay.
	if webhook, readErr := os.ReadFile(filepath.Join(credDir, "alert-webhook")); readErr == nil {
		var alertErr error
		alerts, alertErr = connector.NewAlerts(string(webhook), c.Logf)
		if alertErr != nil {
			alerts = nil
			c.Logf("alerts disabled: invalid webhook credential")
		} else {
			alerts.SetContext(alertContextOf(inst, linkContext))
			c.Health = alerts.Update
			go alerts.Run(ctx)
			c.Logf("Discord health alerts enabled")
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		c.Logf("alerts disabled: webhook credential unreadable")
	}
	c.OnLinkUp = func() { _ = os.Remove(filepath.Join(stateDir, linkRefusedMarker)) }
	c.OnLinkRefused = func(reason error) {
		if markErr := writeLinkRefused(stateDir, reason, time.Now()); markErr != nil {
			c.Logf("refusal marker not written: %v", markErr)
		}
	}
	err = c.Run(ctx)
	if errors.Is(err, context.Canceled) {
		return cli.ExitOK
	}
	if errors.Is(err, connector.ErrOriginDown) {
		return fail(env, cli.ExitOriginDown, "%v", err)
	}
	if errors.Is(err, connector.ErrLinkRefused) {
		if markErr := writeLinkRefused(stateDir, err, time.Now()); markErr != nil {
			c.Logf("refusal marker not written: %v", markErr)
		}
		return fail(env, cli.ExitLinkRefused, "%v", err)
	}
	return fail(env, cli.ExitFailure, "%v", err)
}

// runOperatorDaemon is `internal operator`: root, one Unix socket, the fixed
// provider/profile verbs plus the bounded read-only usage route served to the
// connector service (docs/CONNECTOR.md).
func runOperatorDaemon(env cli.Env, ctx context.Context) int {
	if runtime.GOOS == "darwin" {
		return runMacOperatorDaemon(env, ctx)
	}
	token, err := hermes.Token()
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	srv := operator.Host(runner, token, func(f string, a ...any) { printf(env.Stderr, f, a...) })
	h := srv.Handler()
	printf(env.Stderr, "operator listening on %s (connector only)", layout.OperatorSocket)
	if err := operator.Listen(ctx, layout.OperatorSocket, h, func(f string, a ...any) { printf(env.Stderr, f, a...) }); err != nil {
		return fail(env, cli.ExitFailure, "operator: %v", err)
	}
	return cli.ExitOK
}

func init() {
	cli.Register(cli.Command{Name: "link", Summary: "Pair this runtime with openedbot through the outbound connector", Run: runLink})
}

var _ = fmt.Sprintf
