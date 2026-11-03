package operator

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	maxA2APolicyPeers = 32
	maxA2APeerName    = 64
	maxA2APeerToken   = 256
	maxA2APeerTokens  = 8 << 10
)

var a2aPolicyPeerNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

type A2APeerAccess string

const (
	A2APeerAllow A2APeerAccess = "allow"
	A2APeerDeny  A2APeerAccess = "deny"
)

// A2APeerPolicy is a metadata-only projection. It never contains a bearer
// token or a token-derived fingerprint.
type A2APeerPolicy struct {
	Name                 string        `json:"name,omitempty"`
	Identity             string        `json:"identity"`
	TokenConfigured      bool          `json:"tokenPresent"`
	Access               A2APeerAccess `json:"access"`
	OutgoingConfigured   bool          `json:"outgoingConfigured"`
	OutgoingTokenPresent bool          `json:"outgoingTokenPresent"`
	OutgoingAccess       A2APeerAccess `json:"outgoingAccess"`
}

type a2aOutgoingPeer struct {
	Name         string `json:"name"`
	TokenPresent bool   `json:"tokenPresent"`
}

// A2APolicyView describes the currently configured policy without exposing
// credentials. An empty upstream allow-list means authenticated peers are
// allowed by default, so AccessMode makes that behavior visible.
type A2APolicyView struct {
	AccessMode         string          `json:"accessMode"`
	TrustedPeersSource string          `json:"trustedPeersSource"`
	ProcessObserved    bool            `json:"processObserved"`
	Peers              []A2APeerPolicy `json:"peers"`
}

type a2aPeerCredential struct {
	name  string
	token string
}

type a2aPeerMutationKind string

const (
	a2aPeerTrustMutation       a2aPeerMutationKind = "trust"
	a2aPeerTokenMutation       a2aPeerMutationKind = "token"
	a2aPeerDeleteTokenMutation a2aPeerMutationKind = "delete_token"
)

type a2aPeerMutation struct {
	name    string
	kind    a2aPeerMutationKind
	token   *string // Write-only. Never log or serialize this request value.
	trusted *bool
}

// a2aPolicyDelta contains credential material only for the fixed-path host
// writer. Keep it unexported and never serialize or log this value.
type a2aPolicyDelta struct {
	peerTokens          string
	trustedPeers        []string
	peerTokensChanged   bool
	trustedPeersChanged bool
	needsGatewayRestart bool
}

// projectA2APolicy mirrors the pinned plugin's precedence and access rules:
// A2A_TRUSTED_PEERS overrides config.yaml when non-empty, and an empty trust
// list allows every authenticated identity. The returned view is safe to send
// over the operator API.
func projectA2APolicy(peerTokensEnv, trustedPeersEnv string, configTrusted []string, allowAll bool) (A2APolicyView, error) {
	credentials, err := parseA2APeerTokens(peerTokensEnv)
	if err != nil {
		return A2APolicyView{}, errors.New("the A2A peer token configuration is invalid")
	}

	var trusted []string
	source := "none"
	if strings.TrimSpace(trustedPeersEnv) != "" {
		trusted, err = parseA2ATrustedPeerEnv(trustedPeersEnv)
		if err != nil {
			return A2APolicyView{}, errors.New("the A2A trusted-peer environment is invalid")
		}
		source = "environment"
	} else if len(configTrusted) > 0 {
		trusted, err = normalizeA2ATrustedPeers(configTrusted)
		if err != nil {
			return A2APolicyView{}, errors.New("the A2A trusted-peer configuration is invalid")
		}
		source = "config"
	}

	trustedSet := make(map[string]struct{}, len(trusted))
	for _, identity := range trusted {
		trustedSet[identity] = struct{}{}
	}

	identities := make(map[string]bool, len(credentials)+len(trusted))
	for _, credential := range credentials {
		identities[credential.name] = true
	}
	for _, identity := range trusted {
		if _, exists := identities[identity]; !exists {
			identities[identity] = false
		}
	}

	accessMode := "default_allow"
	if allowAll {
		accessMode = "allow_all_override"
	} else if len(trustedSet) > 0 {
		accessMode = "trusted_peers"
	}

	peers := make([]A2APeerPolicy, 0, len(identities))
	for identity, tokenConfigured := range identities {
		access := A2APeerAllow
		if !allowAll && len(trustedSet) > 0 {
			if _, ok := trustedSet[identity]; !ok {
				access = A2APeerDeny
			}
		}
		if !tokenConfigured && !strings.HasPrefix(identity, "ip:") {
			access = A2APeerDeny
		}
		peer := A2APeerPolicy{Identity: identity, TokenConfigured: tokenConfigured, Access: access, OutgoingAccess: A2APeerDeny}
		if !strings.HasPrefix(identity, "ip:") {
			peer.Name = identity
		}
		peers = append(peers, peer)
	}
	sort.Slice(peers, func(i, j int) bool { return peers[i].Identity < peers[j].Identity })
	return A2APolicyView{AccessMode: accessMode, TrustedPeersSource: source, Peers: peers}, nil
}

func parseA2APeerTokens(raw string) ([]a2aPeerCredential, error) {
	if len(raw) > maxA2APeerTokens || !utf8.ValidString(raw) {
		return nil, errors.New("invalid token configuration")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	pairs := strings.Split(raw, ",")
	if len(pairs) > maxA2APolicyPeers {
		return nil, errors.New("too many peers")
	}
	credentials := make([]a2aPeerCredential, 0, len(pairs))
	tokens := make(map[string]struct{}, len(pairs))
	for _, pair := range pairs {
		name, token, ok := strings.Cut(strings.TrimSpace(pair), ":")
		name, token = strings.TrimSpace(name), strings.TrimSpace(token)
		if !ok || !validA2APeerName(name) || !validA2APeerToken(token, 1) {
			return nil, errors.New("invalid peer entry")
		}
		if _, exists := tokens[token]; exists {
			return nil, errors.New("duplicate peer token")
		}
		tokens[token] = struct{}{}
		credentials = append(credentials, a2aPeerCredential{name: name, token: token})
	}
	return credentials, nil
}

func parseA2ATrustedPeerEnv(raw string) ([]string, error) {
	parts := strings.Split(raw, ",")
	if len(parts) > maxA2APolicyPeers {
		return nil, errors.New("too many trusted peers")
	}
	peers := make([]string, 0, len(parts))
	for _, part := range parts {
		identity := strings.TrimSpace(part)
		if identity == "" {
			continue
		}
		peers = append(peers, identity)
	}
	return normalizeA2ATrustedPeers(peers)
}

func normalizeA2ATrustedPeers(peers []string) ([]string, error) {
	if len(peers) > maxA2APolicyPeers {
		return nil, errors.New("too many trusted peers")
	}
	seen := make(map[string]struct{}, len(peers))
	result := make([]string, 0, len(peers))
	for _, identity := range peers {
		identity = strings.TrimSpace(identity)
		if !validA2APeerIdentity(identity) {
			return nil, errors.New("invalid trusted peer identity")
		}
		if _, exists := seen[identity]; exists {
			continue
		}
		seen[identity] = struct{}{}
		result = append(result, identity)
	}
	sort.Strings(result)
	return result, nil
}

func validA2APeerIdentity(identity string) bool {
	if len(identity) > 128 {
		return false
	}
	if validA2APeerName(identity) {
		return true
	}
	if !strings.HasPrefix(identity, "ip:") {
		return false
	}
	address := strings.TrimPrefix(identity, "ip:")
	if address == "local" || address == "unknown" {
		return true
	}
	return net.ParseIP(address) != nil
}

func validA2APeerName(name string) bool {
	return len(name) <= maxA2APeerName && !strings.Contains(name, "..") && a2aPolicyPeerNameRe.MatchString(name)
}

func validA2APeerToken(token string, minimum int) bool {
	if len(token) < minimum || len(token) > maxA2APeerToken || strings.ContainsRune(token, ',') || !utf8.ValidString(token) {
		return false
	}
	for _, char := range token {
		if char < 0x21 || char > 0x7e {
			return false
		}
	}
	return true
}

func decodeA2APeerTrustMutation(name string, body []byte) (a2aPeerMutation, error) {
	if !validA2APeerName(name) {
		return a2aPeerMutation{}, errors.New("A2A peer request is invalid")
	}
	var wire struct {
		Trusted *bool `json:"trusted"`
	}
	if err := decodeA2APolicyBody(body, &wire); err != nil || wire.Trusted == nil {
		return a2aPeerMutation{}, errors.New("A2A peer request is invalid")
	}
	return a2aPeerMutation{name: name, kind: a2aPeerTrustMutation, trusted: wire.Trusted}, nil
}

func decodeA2APeerTokenMutation(name string, body []byte) (a2aPeerMutation, error) {
	if !validA2APeerName(name) {
		return a2aPeerMutation{}, errors.New("A2A peer request is invalid")
	}
	var wire struct {
		Token *string `json:"token"`
	}
	if err := decodeA2APolicyBody(body, &wire); err != nil || wire.Token == nil || !validA2APeerToken(*wire.Token, 32) {
		return a2aPeerMutation{}, errors.New("A2A peer request is invalid")
	}
	return a2aPeerMutation{name: name, kind: a2aPeerTokenMutation, token: wire.Token}, nil
}

func decodeA2APeerTokenDeleteMutation(name string) (a2aPeerMutation, error) {
	if !validA2APeerName(name) {
		return a2aPeerMutation{}, errors.New("A2A peer request is invalid")
	}
	return a2aPeerMutation{name: name, kind: a2aPeerDeleteTokenMutation}, nil
}

func decodeA2APolicyBody(body []byte, target any) error {
	if len(body) == 0 || len(body) > MaxBody || !utf8.Valid(body) || rejectDuplicateJSONKeys(body) != nil {
		return errors.New("A2A peer request is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("A2A peer request is invalid")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("A2A peer request is invalid")
	}
	return nil
}

func encodeA2APeerTokens(credentials []a2aPeerCredential) (string, error) {
	if len(credentials) > maxA2APolicyPeers {
		return "", errors.New("too many peers")
	}
	seenTokens := make(map[string]struct{}, len(credentials))
	copyOf := append([]a2aPeerCredential(nil), credentials...)
	for _, credential := range copyOf {
		if !validA2APeerName(credential.name) || !validA2APeerToken(credential.token, 1) {
			return "", errors.New("invalid peer entry")
		}
		if _, exists := seenTokens[credential.token]; exists {
			return "", errors.New("duplicate peer token")
		}
		seenTokens[credential.token] = struct{}{}
	}
	sort.Slice(copyOf, func(i, j int) bool {
		if copyOf[i].name != copyOf[j].name {
			return copyOf[i].name < copyOf[j].name
		}
		return copyOf[i].token < copyOf[j].token
	})
	parts := make([]string, 0, len(copyOf))
	for _, credential := range copyOf {
		parts = append(parts, credential.name+":"+credential.token)
	}
	result := strings.Join(parts, ",")
	if len(result) > maxA2APeerTokens {
		return "", errors.New("peer token configuration is too large")
	}
	return result, nil
}

// applyA2APeerTrust changes only the named config.yaml trust list. An empty
// upstream trusted-peer list is default allow, so it may never be written as
// the result of a deny operation.
func applyA2APeerTrust(peerTokensEnv, trustedPeersEnv string, configTrusted []string, allowAll bool, name string, trusted bool) (a2aPolicyDelta, error) {
	return applyA2APeerTrustWithRegistration(peerTokensEnv, trustedPeersEnv, configTrusted, allowAll, name, trusted, false)
}

func applyA2APeerTrustWithRegistration(peerTokensEnv, trustedPeersEnv string, configTrusted []string, allowAll bool, name string, trusted, outgoingRegistered bool) (a2aPolicyDelta, error) {
	if !validA2APeerName(name) || strings.TrimSpace(trustedPeersEnv) != "" || allowAll {
		return a2aPolicyDelta{}, errors.New("an upstream environment policy override is active or the peer name is invalid")
	}
	credentials, err := parseA2APeerTokens(peerTokensEnv)
	if err != nil {
		return a2aPolicyDelta{}, errors.New("the A2A peer token configuration is invalid")
	}
	trustedPeers, err := normalizeA2ATrustedPeers(configTrusted)
	if err != nil {
		return a2aPolicyDelta{}, errors.New("the A2A trusted-peer configuration is invalid")
	}
	if trusted {
		configured := outgoingRegistered
		for _, credential := range credentials {
			if credential.name == name {
				configured = true
				break
			}
		}
		if !configured {
			return a2aPolicyDelta{}, errors.New("a trusted named peer requires an incoming credential or outgoing registration")
		}
		trustedPeers = append(trustedPeers, name)
		trustedPeers, err = normalizeA2ATrustedPeers(trustedPeers)
		if err != nil {
			return a2aPolicyDelta{}, errors.New("the A2A trusted-peer configuration is invalid")
		}
	} else {
		if len(trustedPeers) == 0 {
			return a2aPolicyDelta{}, errors.New("the empty trusted-peer list allows all peers")
		}
		updated := make([]string, 0, len(trustedPeers))
		for _, identity := range trustedPeers {
			if identity != name {
				updated = append(updated, identity)
			}
		}
		if len(updated) == 0 {
			return a2aPolicyDelta{}, errors.New("denying the last trusted peer would allow all peers")
		}
		trustedPeers = updated
	}
	return a2aPolicyDelta{
		peerTokens:          peerTokensEnv,
		trustedPeers:        trustedPeers,
		trustedPeersChanged: !equalStrings(trustedPeers, configTrusted),
	}, nil
}

// applyA2APeerToken computes a canonical .env value for the named identity.
// The caller persists only A2A_PEER_TOKENS. A token change normally requires
// a named gateway restart, unless a read-only live probe proves the value is
// already accepted by the running gateway.
func applyA2APeerToken(peerTokensEnv, name string, token *string) (a2aPolicyDelta, error) {
	if !validA2APeerName(name) || (token != nil && !validA2APeerToken(*token, 32)) {
		return a2aPolicyDelta{}, errors.New("A2A peer token request is invalid")
	}
	credentials, err := parseA2APeerTokens(peerTokensEnv)
	if err != nil {
		return a2aPolicyDelta{}, errors.New("the A2A peer token configuration is invalid")
	}
	updated := make([]a2aPeerCredential, 0, len(credentials)+1)
	for _, credential := range credentials {
		if credential.name == name {
			if token != nil {
				continue
			}
			continue
		}
		updated = append(updated, credential)
	}
	if token != nil {
		updated = append(updated, a2aPeerCredential{name: name, token: *token})
	}
	updatedTokens, err := encodeA2APeerTokens(updated)
	if err != nil {
		return a2aPolicyDelta{}, errors.New("the A2A peer token configuration is invalid")
	}
	changed := updatedTokens != strings.TrimSpace(peerTokensEnv)
	return a2aPolicyDelta{
		peerTokens:          updatedTokens,
		peerTokensChanged:   changed,
		needsGatewayRestart: changed,
	}, nil
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
