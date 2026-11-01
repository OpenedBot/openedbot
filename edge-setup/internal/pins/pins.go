// Package pins holds every upstream version, commit and checksum the tool
// installs. Nothing else in the binary may name a version: a pin changes
// here, in its test, and nowhere else.
//
// Values were carried verbatim from the Ansible roles of the previous tool
// (git show develop:infra/ansible/roles/*/defaults/main.yml).
package pins

import "strings"

// Hermes agent (NousResearch/hermes-agent). The upstream installer is used
// only for its repository stage; uv, Python and dependencies are installed by
// this tool so the installer's network-resolving fallbacks never run as root.
const (
	HermesInstallerRef    = "v0.22.2"
	HermesInstallerBranch = "main"
	HermesInstallerCommit = "d923a5eb487a17c0a68801bba9ef0f56c81040a8"
	HermesInstallerSHA256 = "f4cdb0e20f1aca2c3871a76b962fd4db61510f549cf973759c753ac13349beb5"
	HermesVersion         = "0.22.2"
	HermesInstallerURL    = "https://raw.githubusercontent.com/NousResearch/hermes-agent/" + HermesInstallerRef + "/scripts/install.sh"
)

// HermesExtras are the dependency extras `up` syncs into the runtime venv:
// Hermes' own `all`, plus the provider SDKs openedbot lets an operator
// connect that Hermes keeps out of `all`. Hermes 0.22 loads a provider SDK on
// demand (pyproject: "anything provider-specific belongs in an extra"), and
// SecurityDefaults turns those lazy installs off: an SDK missing here is a
// provider whose every run fails, with a key that still reads as connected.
var HermesExtras = []string{"all", "anthropic"}

// ProviderSDK is one provider SDK extra of the pinned Hermes: the Hermes
// provider slug it serves, the extra that installs it, the Python module whose
// import proves it, and the name the operator recognises.
type ProviderSDK struct {
	Provider string
	Extra    string
	Module   string
	Label    string
}

// HermesProviderSDKs are the providers whose SDK Hermes 0.22.2 loads on demand
// (`pm.ensure_import` in anthropic_adapter, bedrock_adapter, vertex_adapter;
// slugs from hermes_cli/providers.py). Those whose Extra is not in
// HermesExtras are announced at install and reported to the console, never
// installed behind the operator's back.
var HermesProviderSDKs = []ProviderSDK{
	{Provider: "anthropic", Extra: "anthropic", Module: "anthropic", Label: "Anthropic"},
	{Provider: "bedrock", Extra: "bedrock", Module: "boto3", Label: "AWS Bedrock"},
	{Provider: "vertex", Extra: "vertex", Module: "google.auth", Label: "Google Vertex AI"},
}

// Node LTS, for the runtime's Node bridges (the WhatsApp Baileys bridge and
// the Photon sidecar). Without a Node on PATH the upstream runtime scrapes
// nodejs.org and installs its own tree under HERMES_HOME at first use
// (hermes_constants.bootstrap_hermes_managed_node): a pinned, checksummed,
// root-owned tree is installed here instead, and that fallback never runs.
const NodeVersion = "v22.23.2"

// uv and the uv-managed Python. A pinned uv release carries the checksummed
// managed-Python catalogue; `astral.sh/uv/install.sh` is never executed.
const (
	UVVersion     = "0.12.7"
	PythonVersion = "3.14.7"
)

// Docker CE rootless. Versions are the exact apt pins for Debian 13 (trixie);
// the tool refuses a repository that does not provide them.
const (
	DockerEngineVersion     = "5:29.7.2-1~debian.13~trixie"
	ContainerdVersion       = "2.3.4-1~debian.13~trixie"
	DockerAPTKeySHA256      = "1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570"
	DockerAPTKeyFingerprint = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
)

// Container images, pinned by digest.
const (
	// SandboxImage is the upstream default sandbox: Debian + Python 3.11 + Node 20.
	SandboxImage = "nikolaik/python-nodejs:python3.11-nodejs20@sha256:8f958bdc1b4a422bfafd97cab4f69836401f616ae985d4b57a53d254f5bcb038"
	// SandboxBrowserImage is only pulled when the `browser` class is selected.
	SandboxBrowserImage = "mcr.microsoft.com/playwright:v1.55.0-noble@sha256:b27e719ecbfef153e13fd24e8341736733bf2658b229677eb21ff57ff5d7fb29"
	// DockerProbeImage is run once to prove cgroup limits are honoured by the
	// rootless daemon; the host is refused otherwise.
	DockerProbeImage = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
)

// Arch carries the per-architecture artefacts.
type Arch struct {
	// Go is runtime.GOARCH.
	Go string
	// UVTarget is the uv release triple.
	UVTarget string
	// UVArchiveSHA256 is the sha256 of uv-<target>.tar.gz.
	UVArchiveSHA256 string
	// UVBinarySHA256 and UVXBinarySHA256 are re-hashed after extraction.
	UVBinarySHA256  string
	UVXBinarySHA256 string
	// NodeTarget is the Node release architecture ("x64", "arm64").
	NodeTarget string
	// NodeArchiveSHA256 is the sha256 of node-<version>-linux-<target>.tar.xz,
	// as published in that release's SHASUMS256.txt.
	NodeArchiveSHA256 string
	// DebArch is the Debian package architecture.
	DebArch string
}

// Arches lists the supported host architectures.
var Arches = map[string]Arch{
	"amd64": {
		Go:                "amd64",
		UVTarget:          "x86_64-unknown-linux-gnu",
		UVArchiveSHA256:   "788f18abea7c5f55d6216e4f5613fd89d4d59b631efeec117b2b07fe72f1da21",
		UVBinarySHA256:    "8264360c1b0a6f3df3d31620942216f57bba860179a2fc0916af1e5cf87c0d52",
		UVXBinarySHA256:   "459528549fb6ecc4f4b8f3276b64a108557ef55b68451a21b84007e502c153b2",
		NodeTarget:        "x64",
		NodeArchiveSHA256: "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
		DebArch:           "amd64",
	},
	"arm64": {
		Go:                "arm64",
		UVTarget:          "aarch64-unknown-linux-gnu",
		UVArchiveSHA256:   "66393193038dd7eb108abd7a218d9cec04ac70ab98242b0720fa94de19223b7c",
		UVBinarySHA256:    "a42eb41171e452acb03eb03e4901484ca55c991cf178cb5907939dd80c2d9ac8",
		UVXBinarySHA256:   "4b4560c222f57067ab947f0bdc11f9f2167d1741b3814daf6f65aa5e22c78f68",
		NodeTarget:        "arm64",
		NodeArchiveSHA256: "fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8",
		DebArch:           "arm64",
	},
}

// UVArchiveURL is the download location of the uv release archive for an arch.
func UVArchiveURL(a Arch) string {
	return "https://github.com/astral-sh/uv/releases/download/" + UVVersion + "/uv-" + a.UVTarget + ".tar.gz"
}

// NodeArchiveURL is the download location of the Node release archive.
func NodeArchiveURL(a Arch) string {
	return "https://nodejs.org/dist/" + NodeVersion + "/node-" + NodeVersion + "-linux-" + a.NodeTarget + ".tar.xz"
}

// APIToolsets is the toolset catalogue `up` provisions for the api_server
// platform. It is a STARTING POINT, not an invariant: the owner of the
// runtime changes it afterwards, from the console with `edge-setup toolsets`
// or from openedbot through the link. Only ForbiddenToolsets is checked
// forever.
//
// `skills` is provisioned on purpose: it is how a bot LEARNS. openedbot
// turns "learn X" into a skill written by `skill_manage` and read back by
// `skill_view`, and only does so when the inventory announces this toolset.
// Without it the bot can only answer "understood" and record a one-line fact.
var APIToolsets = []string{"web", "terminal", "file", "code_execution", "vision", "image_gen", "bfl", "todo", "skills"}

// AlwaysForbiddenToolsets may never be enabled, on the root or on a named
// profile. They are second schedulers: their deferred work and its failures
// never reach /v1/runs.
var AlwaysForbiddenToolsets = []string{"cronjob", "delegation"}

// ProfileRestrictedToolsets are runtime-side stores. They stay forbidden on
// the root (every bot would share one HERMES_HOME) and are allowed on a
// named profile that openedbot isolates (ADR_BOT_PROFILE).
var ProfileRestrictedToolsets = []string{"memory", "session_search"}

// ForbiddenToolsets is the root/runtime set: always-forbidden plus
// profile-restricted. Unmigrated callers (doctor, `edge-setup toolsets`,
// POST /hermes-setup/toolsets) treat this as the full refusal list. Twin of
// FORBIDDEN_TOOLSETS in openedbot's runtime-contract.ts.
var ForbiddenToolsets = append(append([]string{}, AlwaysForbiddenToolsets...), ProfileRestrictedToolsets...)

// ToolsetIsForbidden reports whether enabling `name` is refused on the given
// scope. profileScope is true for POST /hermes-setup/profiles/{slug}/toolsets.
func ToolsetIsForbidden(name string, profileScope bool) bool {
	for _, item := range AlwaysForbiddenToolsets {
		if item == name {
			return true
		}
	}
	if profileScope {
		return false
	}
	for _, item := range ProfileRestrictedToolsets {
		if item == name {
			return true
		}
	}
	return false
}

// SystemPackages are installed by the base phase before Hermes.
var SystemPackages = []string{
	"ca-certificates", "curl", "git", "xz-utils", "build-essential",
	"python3-dev", "libffi-dev", "openssl", "ripgrep",
}

// HardeningPackages are installed by the base phase for the harden phase.
var HardeningPackages = []string{
	"fail2ban", "libpam-pwquality", "logrotate", "ufw", "unattended-upgrades",
}

// DockerRootlessPrereqs are installed before the rootless daemon.
var DockerRootlessPrereqs = []string{
	"acl", "uidmap", "dbus-user-session", "slirp4netns", "fuse-overlayfs", "iptables", "gpg",
}

// DockerPackages returns the exact apt selections for the pinned engine.
func DockerPackages() []string {
	return []string{
		"docker-ce=" + DockerEngineVersion,
		"docker-ce-cli=" + DockerEngineVersion,
		"containerd.io=" + ContainerdVersion,
		"docker-ce-rootless-extras=" + DockerEngineVersion,
	}
}

// DockerPackageNames are the packages of DockerPackages, held at their pin.
func DockerPackageNames() []string {
	var names []string
	for _, s := range DockerPackages() {
		name, _, _ := strings.Cut(s, "=")
		names = append(names, name)
	}
	return names
}

// PythonMinor is "3.14" for PythonVersion "3.14.7": the interpreter name
// suffix (python3.14) derived from the pin.
func PythonMinor() string {
	parts := strings.SplitN(PythonVersion, ".", 3)
	if len(parts) < 2 {
		return PythonVersion
	}
	return parts[0] + "." + parts[1]
}
