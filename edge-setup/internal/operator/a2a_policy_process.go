package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const (
	a2aPolicyProcessDirName = ".openedbot-a2a-policy"
	a2aPolicyProcessSock    = "state.sock"
	a2aPolicyProcessSchema  = 1
	a2aPolicyProcessTimeout = 750 * time.Millisecond
)

var a2aPolicyGenerationRE = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

var a2aPolicySnapshotRequest = []byte("{\"schema\":1,\"op\":\"snapshot\"}\n")

type a2aPolicyProcessSnapshotWire struct {
	Schema               *int      `json:"schema"`
	Generation           *string   `json:"generation"`
	PeerNames            *[]string `json:"peerNames"`
	TrustedPeers         *[]string `json:"trustedPeers"`
	PeerTokensOverride   *bool     `json:"peerTokensOverride"`
	TrustedPeersOverride *bool     `json:"trustedPeersOverride"`
	AllowAllUsers        *bool     `json:"allowAllUsers"`
	LocalhostOnly        *bool     `json:"localhostOnly"`
	PolicyGuard          *bool     `json:"policyGuard"`
}

// observeA2APolicyProcess reads the effective A2A policy from the pinned
// gateway plugin through one fixed local socket. It never returns token values.
func observeA2APolicyProcess(runtimeRoot string, owner fsx.Owner) a2aPolicyProcessObserver {
	return func(parent context.Context) (a2aPolicyProcessState, error) {
		if parent == nil {
			return a2aPolicyProcessState{}, errors.New("A2A policy process snapshot is unavailable")
		}
		ctx, cancel := context.WithTimeout(parent, a2aPolicyProcessTimeout)
		defer cancel()
		if err := ctx.Err(); err != nil {
			return a2aPolicyProcessState{}, errors.New("A2A policy process snapshot is unavailable")
		}

		socketPath, err := checkedA2APolicyProcessSocket(runtimeRoot, owner)
		if err != nil {
			return a2aPolicyProcessState{}, errors.New("A2A policy process socket is unsafe or unavailable")
		}
		conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		if err != nil {
			return a2aPolicyProcessState{}, errors.New("A2A policy process socket is unavailable")
		}
		defer conn.Close()
		unixConn, ok := conn.(*net.UnixConn)
		if !ok || verifyA2APolicyProcessPeer(unixConn, owner) != nil {
			return a2aPolicyProcessState{}, errors.New("A2A policy process socket peer is not trusted")
		}
		if deadline, ok := ctx.Deadline(); ok {
			if err := conn.SetDeadline(deadline); err != nil {
				return a2aPolicyProcessState{}, errors.New("A2A policy process socket deadline failed")
			}
		}
		stopCancel := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
		defer stopCancel()
		written, err := conn.Write(a2aPolicySnapshotRequest)
		if err != nil || written != len(a2aPolicySnapshotRequest) {
			return a2aPolicyProcessState{}, errors.New("A2A policy process snapshot request failed")
		}
		body, err := io.ReadAll(io.LimitReader(conn, maxA2APolicyOutput+1))
		if err != nil || len(body) == 0 || len(body) > maxA2APolicyOutput {
			return a2aPolicyProcessState{}, errors.New("A2A policy process snapshot response is unavailable")
		}
		state, err := decodeA2APolicyProcessSnapshot(body)
		if err != nil {
			return a2aPolicyProcessState{}, errors.New("A2A policy process snapshot response is invalid")
		}
		if err := ctx.Err(); err != nil {
			return a2aPolicyProcessState{}, errors.New("A2A policy process snapshot was canceled")
		}
		return state, nil
	}
}

func checkedA2APolicyProcessSocket(runtimeRoot string, owner fsx.Owner) (string, error) {
	if runtimeRoot == "" || !filepath.IsAbs(runtimeRoot) || filepath.Clean(runtimeRoot) != runtimeRoot ||
		runtimeRoot == string(filepath.Separator) || owner.UID < 0 || owner.GID < 0 {
		return "", errors.New("invalid A2A runtime root")
	}
	root, err := fsx.Lstat(runtimeRoot)
	if err != nil || !root.Exists || !root.Dir || root.Symlink || root.Owner != owner {
		return "", errors.New("unsafe A2A runtime root")
	}

	directory := filepath.Join(runtimeRoot, a2aPolicyProcessDirName)
	stateDir, err := fsx.Lstat(directory)
	if err != nil || !stateDir.Exists || !stateDir.Dir || stateDir.Symlink ||
		stateDir.Owner != owner || stateDir.Mode != 0o700 {
		return "", errors.New("unsafe A2A policy process directory")
	}

	socketPath := filepath.Join(directory, a2aPolicyProcessSock)
	socket, err := fsx.Lstat(socketPath)
	if err != nil || !socket.Exists || socket.Regular || socket.Dir || socket.Symlink ||
		socket.Owner != owner || socket.Mode != 0o600 {
		return "", errors.New("unsafe A2A policy process socket")
	}
	info, err := os.Lstat(socketPath)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("A2A policy process path is not a socket")
	}
	return socketPath, nil
}

func decodeA2APolicyProcessSnapshot(body []byte) (a2aPolicyProcessState, error) {
	if len(body) == 0 || len(body) > maxA2APolicyOutput || !utf8.Valid(body) || rejectDuplicateJSONKeys(body) != nil {
		return a2aPolicyProcessState{}, errors.New("invalid snapshot encoding")
	}
	var wire a2aPolicyProcessSnapshotWire
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return a2aPolicyProcessState{}, errors.New("invalid snapshot object")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return a2aPolicyProcessState{}, errors.New("snapshot contains trailing data")
	}
	if wire.Schema == nil || *wire.Schema != a2aPolicyProcessSchema ||
		wire.Generation == nil || !a2aPolicyGenerationRE.MatchString(*wire.Generation) ||
		wire.PeerNames == nil || *wire.PeerNames == nil ||
		wire.TrustedPeers == nil || *wire.TrustedPeers == nil ||
		wire.PeerTokensOverride == nil || wire.TrustedPeersOverride == nil ||
		wire.AllowAllUsers == nil || wire.LocalhostOnly == nil || wire.PolicyGuard == nil || !*wire.PolicyGuard {
		return a2aPolicyProcessState{}, errors.New("snapshot schema or guard is invalid")
	}
	if len(*wire.PeerNames) > maxA2APolicyPeers || len(*wire.TrustedPeers) > maxA2APolicyPeers {
		return a2aPolicyProcessState{}, errors.New("snapshot peer count exceeds bounds")
	}
	if *wire.LocalhostOnly && len(*wire.PeerNames) != 0 {
		return a2aPolicyProcessState{}, errors.New("localhost-only snapshot cannot expose token peers")
	}
	for index, name := range *wire.PeerNames {
		if !validA2APeerName(name) || index > 0 && (*wire.PeerNames)[index-1] >= name {
			return a2aPolicyProcessState{}, errors.New("snapshot peer names are invalid")
		}
	}
	trusted, err := normalizeA2ATrustedPeers(*wire.TrustedPeers)
	if err != nil || !equalStrings(trusted, *wire.TrustedPeers) {
		return a2aPolicyProcessState{}, errors.New("snapshot trusted peers are invalid")
	}
	state := a2aPolicyProcessState{
		Known:                true,
		Running:              true,
		Generation:           *wire.Generation,
		PeerNames:            append([]string(nil), (*wire.PeerNames)...),
		TrustedPeers:         append([]string(nil), (*wire.TrustedPeers)...),
		PeerTokensOverride:   *wire.PeerTokensOverride,
		TrustedPeersOverride: *wire.TrustedPeersOverride,
		AllowAllUsers:        *wire.AllowAllUsers,
		LocalhostOnly:        *wire.LocalhostOnly,
	}
	if err := validateA2APolicyProcessState(state); err != nil {
		return a2aPolicyProcessState{}, errors.New("snapshot process state is invalid")
	}
	return state, nil
}
