package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/term"
)

// connectorRoot is /etc/hermes/connector; tests redirect it under a
// temporary directory, and own what they write there (only root can hand a
// file to root).
var (
	connectorRoot      = layout.ConnectorDir
	connectorStateRoot = layout.ConnectorStateDir
	connectorOwner     = fsx.Root
)

// stateDirOf mirrors ConnectorInstance.StateDir under the (redirectable)
// state root.
func stateDirOf(inst layout.ConnectorInstance) string {
	if inst.IsDefault() {
		return connectorStateRoot
	}
	return filepath.Join(connectorStateRoot, string(inst))
}

func linkPathOf(inst layout.ConnectorInstance) string {
	return filepath.Join(inst.DirUnder(connectorRoot), "link.json")
}

func deviceKeyPathOf(inst layout.ConnectorInstance) string {
	return filepath.Join(inst.DirUnder(connectorRoot), "device.key.cred")
}

// linkRefusedMarker is written in the instance state directory by the daemon
// when it stops on ErrLinkRefused, and removed by the next confirmed session
// or by `link`. doctor and status read it to say why the unit is down.
const linkRefusedMarker = "link-refused"

func writeLinkRefused(stateDir string, reason error, now time.Time) error {
	body := fmt.Sprintf("at=%s\nreason=%s\n", now.UTC().Format(time.RFC3339), strings.ReplaceAll(reason.Error(), "\n", " "))
	return os.WriteFile(filepath.Join(stateDir, linkRefusedMarker), []byte(body), 0o600)
}

// linkAdmittedMarker is written by the daemon each time openedbot admits
// a session: link.context only follows an accepted proof of possession, where
// the first broker frame (link.challenge) does not. It names the agent that
// was admitted, so an automatic upgrade proves the link on the new binary.
const linkAdmittedMarker = "link-admitted"

// admittedAgentMarker is the agent spelling written to the admission marker.
// The wire hello says edge-setup/<version>, but a v0.4.0 binary proving its
// own automatic upgrade to this release compares the marker with
// "hermes-setup/<version>" verbatim, so the marker keeps the pre-rename
// spelling until v0.6.0 (OHB-87). proveUpgrade accepts both (admittedAs).
func admittedAgentMarker(agent string) string {
	if v, ok := strings.CutPrefix(agent, "edge-setup/"); ok {
		return "hermes-setup/" + v
	}
	return agent
}

// admittedAs reports whether the agent read from the admission marker is
// want, in its wire spelling or in the marker spelling.
func admittedAs(got, want string) bool {
	return got == want || got == admittedAgentMarker(want)
}

func writeLinkAdmitted(stateDir, agent string, now time.Time) error {
	body := fmt.Sprintf("at=%s\nagent=%s\n", now.UTC().Format(time.RFC3339Nano), agent)
	return fsx.WriteAtomic(filepath.Join(stateDir, linkAdmittedMarker), []byte(body), 0o600, fsx.Current())
}

// linkAdmitted reads the last admission of the instance whose state
// directory is stateDir.
func linkAdmitted(stateDir string) (at time.Time, agent string, ok bool) {
	data, err := os.ReadFile(filepath.Join(stateDir, linkAdmittedMarker))
	if err != nil {
		return time.Time{}, "", false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if v, found := strings.CutPrefix(line, "at="); found {
			at, err = time.Parse(time.RFC3339Nano, v)
			if err != nil {
				return time.Time{}, "", false
			}
		} else if v, found := strings.CutPrefix(line, "agent="); found {
			agent = v
		}
	}
	return at, agent, !at.IsZero()
}

// linkRefusal returns the recorded stop, or ok=false when the instance was
// never stopped on refusals.
func linkRefusal(inst layout.ConnectorInstance) (at, reason string, ok bool) {
	data, err := os.ReadFile(filepath.Join(stateDirOf(inst), linkRefusedMarker))
	if err != nil {
		return "", "", false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if v, found := strings.CutPrefix(line, "at="); found {
			at = v
		} else if v, found := strings.CutPrefix(line, "reason="); found {
			reason = v
		}
	}
	return at, reason, true
}

// linkRefusalProblem is doctor's line for an instance stopped on refusals,
// empty otherwise.
func linkRefusalProblem(inst layout.ConnectorInstance) string {
	at, reason, ok := linkRefusal(inst)
	if !ok {
		return ""
	}
	name := ""
	if !inst.IsDefault() {
		name = " --name " + string(inst)
	}
	return fmt.Sprintf("%s.service refused by openedbot since %s: %s. If the runtime was deleted there, run `edge-setup link --ohb https://… --yes%s` with a new ticket, or remove this instance", inst.Unit(), at, reason, name)
}

// readLinkFile decodes an instance's link.json; absent is (nil, nil).
func readLinkFile(inst layout.ConnectorInstance) (*LinkFile, error) {
	data, err := os.ReadFile(linkPathOf(inst))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var lf LinkFile
	if err := json.Unmarshal(data, &lf); err != nil || lf.Schema != 1 || lf.RuntimeID == "" || lf.LinkToken == "" || lf.WSURL == "" {
		return nil, fmt.Errorf("%s is invalid; run `edge-setup link` again", linkPathOf(inst))
	}
	return &lf, nil
}

// connectorInstances lists the default instance, always, then every named
// instance whose directory holds a link.json, sorted by name. A directory
// without a link is not an instance: nothing can start from it.
func connectorInstances() []layout.ConnectorInstance {
	out := []layout.ConnectorInstance{layout.DefaultConnectorInstance}
	entries, err := os.ReadDir(connectorRoot)
	if err != nil {
		return out
	}
	var named []layout.ConnectorInstance
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		inst, err := layout.ParseConnectorInstance(e.Name())
		if err != nil || inst.IsDefault() || !fsx.Exists(linkPathOf(inst)) {
			continue
		}
		named = append(named, inst)
	}
	sort.Slice(named, func(i, j int) bool { return named[i] < named[j] })
	return append(out, named...)
}

// linkedInstances is connectorInstances restricted to those with a link.
func linkedInstances() []layout.ConnectorInstance {
	var out []layout.ConnectorInstance
	for _, inst := range connectorInstances() {
		if fsx.Exists(linkPathOf(inst)) {
			out = append(out, inst)
		}
	}
	return out
}

// linkTakeover reports what `link` is about to replace on this instance.
//
// A host holds one link per instance and re-linking always wins: going from a
// development openedbot to production, or back, is the same command with
// another --ohb and never a refusal to argue with. What the old guard
// protected is kept as a duty to speak: the previous origin and runtime are
// named out loud, because the openedbot being left keeps a runtime row
// this host will never dial again, and only the operator can remove it there.
//
// `previous` is nil when nothing usable is linked. `switching` is true only
// when the origin actually changes: a fresh ticket on the same origin is a
// re-enrollment, not a switch.
func linkTakeover(inst layout.ConnectorInstance, origin string) (previous *LinkFile, switching bool) {
	cur, err := readLinkFile(inst)
	if err != nil || cur == nil {
		// An unreadable link.json holds nothing worth keeping: the new
		// enrollment replaces it either way, and has nothing to announce.
		return nil, false
	}
	return cur, cur.OHB != origin
}

// instanceStatus is one line of `status` and one entry of its JSON.
type instanceStatus struct {
	Name      string `json:"name"`
	Unit      string `json:"unit"`
	Active    bool   `json:"active"`
	Link      bool   `json:"link_present"`
	OHB       string `json:"ohb,omitempty"`
	RuntimeID string `json:"runtime_id,omitempty"`
	DeviceKey bool   `json:"device_key_sealed"`
	// Refused is true when the daemon stopped on openedbot refusals.
	Refused bool `json:"link_refused"`
	// Environment (dev, preprod, prod), Organization and Owner are what
	// openedbot declared through link.context; empty until a session.
	Environment  string `json:"ohb_environment,omitempty"`
	Organization string `json:"organization,omitempty"`
	Owner        string `json:"owner,omitempty"`
}

// connectorStatus reports every instance: origin and runtime from link.json
// (never the token), the declared tier and owner (link.json, then the
// daemon's overlay), unit activity from systemd, and whether a device key is
// sealed next to the link.
func connectorStatus(ctx context.Context, sd systemd.Client) []instanceStatus {
	var out []instanceStatus
	for _, inst := range connectorInstances() {
		s := instanceStatus{Name: inst.Label(), Unit: inst.Unit() + ".service", Link: fsx.Exists(linkPathOf(inst)), DeviceKey: fsx.Exists(deviceKeyPathOf(inst))}
		s.Active, _ = sd.IsActive(ctx, inst.Unit())
		_, _, s.Refused = linkRefusal(inst)
		if lf, err := readLinkFile(inst); err == nil && lf != nil {
			s.OHB, s.RuntimeID = lf.OHB, lf.RuntimeID
			lc := lf.linkContext()
			if stored, ok := loadLinkContext(filepath.Join(stateDirOf(inst), "link-context.json"), lf.RuntimeID); ok {
				lc = stored
			}
			s.Environment, s.Organization, s.Owner = lc.Environment, lc.Organization.Name, lc.Owner.Email
		}
		out = append(out, s)
	}
	return out
}

// connectorStatusLine is the `status` line of one instance. The name is
// padded so the columns of two instances line up.
func connectorStatusLine(c term.Color, s instanceStatus) string {
	line := fmt.Sprintf("connector   %-8s active=%s link=%s key=%s", s.Name, boolLabel(c, s.Active), boolLabel(c, s.Link), boolLabel(c, s.DeviceKey))
	if s.Refused {
		line += " " + c.Red("refused")
	}
	if s.OHB != "" {
		line += " ohb=" + s.OHB + " runtime=" + s.RuntimeID
	}
	if s.Environment != "" {
		line += " env=" + s.Environment
	}
	if s.Owner != "" {
		line += " owner=" + s.Owner
	}
	return line
}
