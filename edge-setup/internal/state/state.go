// Package state persists the tool's non-secret configuration and progress in
// /etc/hermes/hermes-setup.json. Secrets never enter this file; the rollback
// never reads it.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// SchemaVersion 2 records the host-wide features selected by the operator.
// Schema 1 remains readable and is normalised conservatively in memory: a
// successful legacy hardening phase means every old hardening feature stays
// selected. The next mutating command persists the normalised schema.
const SchemaVersion = 2

// Mode is the reachability mode.
type Mode string

// Reachability modes.
const (
	ModeNone      Mode = "none"
	ModeConnector Mode = "connector"
)

// Phase records one completed phase of `up`.
type Phase struct {
	DoneAt     time.Time `json:"done_at"`
	InputsHash string    `json:"inputs_hash,omitempty"`
}

// Features records only optional, host-wide policy. Runtime invariants such
// as the unprivileged service account, loopback gateway, secret permissions
// and systemd confinement are deliberately not configurable.
type Features struct {
	Sandbox             bool     `json:"sandbox"`
	PersistentJournal   bool     `json:"persistent_journal"`
	UnattendedUpgrades  bool     `json:"unattended_upgrades"`
	SudoLogging         bool     `json:"sudo_logging"`
	PasswordPolicy      bool     `json:"password_policy"`
	DisableLLMNR        bool     `json:"disable_llmnr"`
	Firewall            bool     `json:"firewall"`
	AllowedInbound      []string `json:"allowed_inbound,omitempty"`
	Fail2Ban            bool     `json:"fail2ban"`
	SSHHardening        bool     `json:"ssh_hardening"`
	QuarantineCloudUser bool     `json:"quarantine_cloud_user"`
}

// HostPolicyEnabled reports whether up must enter the optional host-policy
// phase. The runtime sandbox and journal are handled by their own phases.
func (f Features) HostPolicyEnabled() bool {
	return f.UnattendedUpgrades || f.SudoLogging || f.PasswordPolicy ||
		f.DisableLLMNR || f.Firewall || f.Fail2Ban || f.SSHHardening ||
		f.QuarantineCloudUser
}

// EnabledPolicyNames returns stable human-facing names for plan/status.
func (f Features) EnabledPolicyNames() []string {
	var names []string
	for name, enabled := range map[string]bool{
		"unattended-upgrades": f.UnattendedUpgrades, "sudo-logging": f.SudoLogging,
		"password-policy": f.PasswordPolicy, "disable-llmnr": f.DisableLLMNR,
		"firewall": f.Firewall, "fail2ban": f.Fail2Ban,
		"ssh-hardening": f.SSHHardening, "quarantine-cloud-user": f.QuarantineCloudUser,
	} {
		if enabled {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return []string{"none selected"}
	}
	return names
}

// EnabledNames includes the separately handled sandbox and journal features.
func (f Features) EnabledNames() []string {
	names := f.EnabledPolicyNames()
	if len(names) == 1 && names[0] == "none selected" {
		names = nil
	}
	if f.Sandbox {
		names = append(names, "sandbox")
	}
	if f.PersistentJournal {
		names = append(names, "persistent-journal")
	}
	sort.Strings(names)
	if len(names) == 0 {
		return []string{"minimal"}
	}
	return names
}

// Merge enables newly requested features without treating an omitted flag as
// a request to remove a policy already selected on this host.
func (f *Features) Merge(requested Features) {
	f.Sandbox = f.Sandbox || requested.Sandbox
	f.PersistentJournal = f.PersistentJournal || requested.PersistentJournal
	f.UnattendedUpgrades = f.UnattendedUpgrades || requested.UnattendedUpgrades
	f.SudoLogging = f.SudoLogging || requested.SudoLogging
	f.PasswordPolicy = f.PasswordPolicy || requested.PasswordPolicy
	f.DisableLLMNR = f.DisableLLMNR || requested.DisableLLMNR
	f.Firewall = f.Firewall || requested.Firewall
	f.Fail2Ban = f.Fail2Ban || requested.Fail2Ban
	f.SSHHardening = f.SSHHardening || requested.SSHHardening
	f.QuarantineCloudUser = f.QuarantineCloudUser || requested.QuarantineCloudUser
	if len(requested.AllowedInbound) > 0 {
		seen := make(map[string]bool, len(f.AllowedInbound)+len(requested.AllowedInbound))
		merged := make([]string, 0, len(f.AllowedInbound)+len(requested.AllowedInbound))
		for _, rule := range append(append([]string{}, f.AllowedInbound...), requested.AllowedInbound...) {
			if !seen[rule] {
				seen[rule] = true
				merged = append(merged, rule)
			}
		}
		f.AllowedInbound = merged
	}
}

// Equal compares feature selections while treating inbound rules as a set.
func (f Features) Equal(other Features) bool {
	if f.Sandbox != other.Sandbox || f.PersistentJournal != other.PersistentJournal ||
		f.UnattendedUpgrades != other.UnattendedUpgrades || f.SudoLogging != other.SudoLogging ||
		f.PasswordPolicy != other.PasswordPolicy || f.DisableLLMNR != other.DisableLLMNR ||
		f.Firewall != other.Firewall || f.Fail2Ban != other.Fail2Ban ||
		f.SSHHardening != other.SSHHardening || f.QuarantineCloudUser != other.QuarantineCloudUser {
		return false
	}
	want := make(map[string]bool, len(f.AllowedInbound))
	for _, rule := range f.AllowedInbound {
		want[rule] = true
	}
	got := make(map[string]bool, len(other.AllowedInbound))
	for _, rule := range other.AllowedInbound {
		got[rule] = true
	}
	if len(want) != len(got) {
		return false
	}
	for rule := range want {
		if !got[rule] {
			return false
		}
	}
	return true
}

// NewComparedTo returns only selections that are absent from previous. When
// inbound declarations grow, Firewall is set and the complete desired rule
// set is returned so the firewall convergence remains exact.
func (f Features) NewComparedTo(previous Features) Features {
	delta := Features{
		Sandbox: f.Sandbox && !previous.Sandbox, PersistentJournal: f.PersistentJournal && !previous.PersistentJournal,
		UnattendedUpgrades: f.UnattendedUpgrades && !previous.UnattendedUpgrades,
		SudoLogging:        f.SudoLogging && !previous.SudoLogging, PasswordPolicy: f.PasswordPolicy && !previous.PasswordPolicy,
		DisableLLMNR: f.DisableLLMNR && !previous.DisableLLMNR, Firewall: f.Firewall && !previous.Firewall,
		Fail2Ban: f.Fail2Ban && !previous.Fail2Ban, SSHHardening: f.SSHHardening && !previous.SSHHardening,
		QuarantineCloudUser: f.QuarantineCloudUser && !previous.QuarantineCloudUser,
	}
	previousRules := make(map[string]bool, len(previous.AllowedInbound))
	for _, rule := range previous.AllowedInbound {
		previousRules[rule] = true
	}
	for _, rule := range f.AllowedInbound {
		if !previousRules[rule] {
			delta.Firewall = true
			delta.AllowedInbound = append([]string{}, f.AllowedInbound...)
			break
		}
	}
	if delta.Firewall && len(delta.AllowedInbound) == 0 {
		delta.AllowedInbound = append([]string{}, f.AllowedInbound...)
	}
	return delta
}

// File is the persisted document.
type File struct {
	Schema      int    `json:"schema"`
	ToolVersion string `json:"tool_version"`
	Mode        Mode   `json:"mode"`
	// Hostname is retained only to read legacy state; connector state clears it.
	Hostname string `json:"hostname,omitempty"`
	PublicIP string `json:"public_ip,omitempty"`
	// Legacy summary fields remain for schema-1 and status compatibility.
	SSHHardening        bool   `json:"ssh_hardening"`
	AdminUser           string `json:"admin_user,omitempty"`
	AdminKeyFingerprint string `json:"admin_key_fingerprint,omitempty"`
	// AdminSudo is the sudo rule given to AdminUser: "password", "nopasswd",
	// or empty for a host hardened before the choice existed (nopasswd).
	AdminSudo                string   `json:"admin_sudo,omitempty"`
	QuarantineUser           string   `json:"quarantine_user,omitempty"`
	QuarantineKeyFingerprint string   `json:"quarantine_key_fingerprint,omitempty"`
	DockerEnabled            bool     `json:"docker_enabled"`
	Features                 Features `json:"features"`
	// Phases maps a phase name (preflight, base, …) to its completion.
	Phases map[string]Phase `json:"phases"`
	// PinsApplied records the versions installed, for `status` and `update`.
	PinsApplied map[string]string `json:"pins_applied"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

// New returns an empty document.
func New(toolVersion string) *File {
	return &File{
		Schema:      SchemaVersion,
		ToolVersion: toolVersion,
		Mode:        ModeNone,
		Phases:      map[string]Phase{},
		PinsApplied: map[string]string{},
	}
}

// Path is the state file; overridable for tests.
var Path = layout.ToolConfig

// Load reads the state file. A missing file returns (nil, nil).
func Load() (*File, error) {
	return LoadFrom(Path, fsx.Root)
}

// LoadFrom reads a state file at path owned by owner.
func LoadFrom(path string, owner fsx.Owner) (*File, error) {
	data, err := fsx.ReadRegular(path, 0o600, owner)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if f.Schema != 1 && f.Schema != SchemaVersion {
		return nil, fmt.Errorf("%s: schema %d is not supported by this build (want 1 or %d)", path, f.Schema, SchemaVersion)
	}
	if f.Phases == nil {
		f.Phases = map[string]Phase{}
	}
	if f.PinsApplied == nil {
		f.PinsApplied = map[string]string{}
	}
	if f.Schema == 1 {
		f.Features.Sandbox = f.DockerEnabled
		if _, ok := f.Phases["base"]; ok {
			f.Features.PersistentJournal = true
		}
		if _, ok := f.Phases["harden"]; ok {
			f.Features.UnattendedUpgrades = true
			f.Features.SudoLogging = true
			f.Features.PasswordPolicy = true
			f.Features.DisableLLMNR = true
			f.Features.Firewall = true
			f.Features.Fail2Ban = true
			f.Features.SSHHardening = f.SSHHardening
			f.Features.QuarantineCloudUser = f.QuarantineUser != ""
			if f.SSHHardening {
				f.Features.AllowedInbound = []string{"22/tcp"}
			}
		}
		f.Schema = SchemaVersion
	}
	// Keep the legacy summary fields coherent for status/export consumers.
	f.DockerEnabled = f.Features.Sandbox
	f.SSHHardening = f.Features.SSHHardening
	return &f, nil
}

// Save writes the state file atomically, root-only.
func (f *File) Save() error {
	return f.SaveTo(Path, fsx.Root)
}

// SaveTo writes the state file at path owned by owner.
func (f *File) SaveTo(path string, owner fsx.Owner) error {
	f.Schema = SchemaVersion
	f.UpdatedAt = time.Now().UTC()
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return err
	}
	return fsx.WriteAtomic(path, append(data, '\n'), 0o600, owner)
}

// MarkPhase records a phase as done now.
func (f *File) MarkPhase(name, inputsHash string) {
	f.Phases[name] = Phase{DoneAt: time.Now().UTC(), InputsHash: inputsHash}
}

// PhaseDone reports whether a phase completed with the same inputs.
func (f *File) PhaseDone(name, inputsHash string) bool {
	p, ok := f.Phases[name]
	return ok && p.InputsHash == inputsHash
}

func dirOf(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' {
			if i == 0 {
				return "/"
			}
			return path[:i]
		}
	}
	return "."
}
