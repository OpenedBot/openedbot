package operator

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	hostexec "github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

type a2aPolicyHostRunner struct {
	t        *testing.T
	state    a2aPolicyFileState
	actions  []string
	commands []string
}

func (r *a2aPolicyHostRunner) Run(_ context.Context, command hostexec.Cmd) (hostexec.Result, error) {
	if command.Path != "python3" || len(command.Args) != 4 || command.Args[0] != "-I" || command.Args[1] != "-c" {
		r.t.Fatalf("policy helper used an unexpected interpreter command: %q", command.String())
	}
	if command.Timeout != a2aPolicyPythonTimeout {
		r.t.Fatal("policy helper did not use its bounded timeout")
	}
	r.commands = append(r.commands, command.String())
	action := command.Args[3]
	r.actions = append(r.actions, action)
	var request map[string]json.RawMessage
	if len(command.Stdin) > MaxBody || json.Unmarshal(command.Stdin, &request) != nil {
		r.t.Fatal("policy helper request was missing, malformed, or oversized")
	}
	switch action {
	case "read":
	case "token-set":
		var value struct {
			Value string `json:"value"`
		}
		if json.Unmarshal(command.Stdin, &value) != nil {
			r.t.Fatal("token write request was malformed")
		}
		r.state.PeerTokens = value.Value
		r.state.PeerTokensPresent = true
	case "trust-set":
		var value struct {
			Peers []string `json:"trustedPeers"`
		}
		if json.Unmarshal(command.Stdin, &value) != nil {
			r.t.Fatal("trusted-peer write request was malformed")
		}
		r.state.ConfigTrusted = value.Peers
	default:
		r.t.Fatalf("unexpected policy action %q", action)
	}
	encoded, err := json.Marshal(r.state)
	if err != nil {
		r.t.Fatal("could not encode fake policy state")
	}
	return hostexec.Result{Stdout: string(encoded), ExitCode: 0}, nil
}

func newA2APolicyHostFixture(t *testing.T, state a2aPolicyFileState, observer a2aPolicyProcessObserver, prover a2aPolicyPeerProver) (*a2aPolicyHost, *a2aPolicyHostRunner) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal("could not secure policy fixture directory")
	}
	for _, name := range []string{".env", "config.yaml"} {
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal("could not create policy fixture file")
		}
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal("could not secure policy fixture file")
		}
	}
	runner := &a2aPolicyHostRunner{t: t, state: state}
	host, err := newA2APolicyHost(a2aPolicyHostConfig{
		RuntimeRoot: root,
		Owner:       fsx.Current(),
		Runner:      runner,
		Command: func(string) hostexec.Cmd {
			return hostexec.Cmd{Path: "python3", Args: []string{"-I"}, Env: []string{"HERMES_HOME=" + root}}
		},
		ObserveProcess: observer,
		ProbePeer:      prover,
	})
	if err != nil {
		t.Fatal("could not construct policy host")
	}
	return host, runner
}

func TestA2APolicyHostTokenWriteUsesReadbackAndLiveProbe(t *testing.T) {
	const token = "fixture-new-peer-token-0123456789abcdef"
	process := a2aPolicyProcessState{Known: true, Running: true, Generation: "pid-42:start-7", PeerNames: []string{"alpha"}}
	var probes int
	host, runner := newA2APolicyHostFixture(t, a2aPolicyFileState{PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true}, func(context.Context) (a2aPolicyProcessState, error) {
		return process, nil
	}, func(_ context.Context, peer, gotToken string, expected A2APeerAccess) (a2aPolicyProbeResult, error) {
		probes++
		if peer != "alpha" || gotToken != token || expected != A2APeerAllow {
			t.Fatal("token proof did not use the read-back value and projected access")
		}
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeAllowed, code: a2aErrTaskNotFound}, nil
	})

	status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerTokenMutation, token: stringPtr(token)})
	if err != nil || !status.Persisted || !status.Effective || status.NeedsGatewayRestart {
		t.Fatal("a live read-only probe did not prove the persisted peer token")
	}
	if probes != 1 || !equalStrings(runner.actions, []string{"read", "token-set", "read"}) {
		t.Fatal("token write did not follow read, fixed-path write, readback, and live probe")
	}
	if strings.Contains(strings.Join(runner.commands, " "), token) {
		t.Fatal("write-only token appeared in command arguments")
	}
	encodedStatus, err := json.Marshal(status)
	if err != nil || strings.Contains(string(encodedStatus), token) {
		t.Fatal("write-only token appeared in the response status")
	}
}

func TestA2APolicyHostTokenWriteRemainsPendingWhenProbeCannotProveIt(t *testing.T) {
	const token = "fixture-pending-peer-token-0123456789abcdef"
	process := a2aPolicyProcessState{Known: true, Running: true, Generation: "pid-42:start-7"}
	host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{}, func(context.Context) (a2aPolicyProcessState, error) {
		return process, nil
	}, func(context.Context, string, string, A2APeerAccess) (a2aPolicyProbeResult, error) {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, nil
	})

	status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerTokenMutation, token: stringPtr(token)})
	if err != nil || !status.Persisted || status.Effective || !status.NeedsGatewayRestart {
		t.Fatal("an unproved token write was reported as effective or lost its restart requirement")
	}
}

func TestA2APolicyHostTokenProbeUsesObservedLiveTrustList(t *testing.T) {
	const token = "fixture-live-denied-token-0123456789abcdef"
	process := a2aPolicyProcessState{
		Known: true, Running: true, Generation: "pid-42:start-7",
		PeerNames: []string{"alpha"}, TrustedPeers: []string{"beta"},
	}
	host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{
		PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true,
		ConfigTrusted: []string{"alpha"},
	}, func(context.Context) (a2aPolicyProcessState, error) {
		return process, nil
	}, func(_ context.Context, peer, gotToken string, expected A2APeerAccess) (a2aPolicyProbeResult, error) {
		if peer != "alpha" || gotToken != token || expected != A2APeerDeny {
			t.Fatal("token probe ignored the current process trusted-peer list")
		}
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeDenied, code: a2aErrUntrustedPeer}, nil
	})

	status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerTokenMutation, token: stringPtr(token)})
	if err != nil || !status.Persisted || !status.Effective || status.NeedsGatewayRestart {
		t.Fatal("authenticated deny from the current policy did not prove the token/trust state")
	}
}

func TestA2APolicyHostTrustWriteUsesFixedConfigAndLiveProbe(t *testing.T) {
	process := a2aPolicyProcessState{Known: true, Running: true, Generation: "pid-42:start-7", PeerNames: []string{"alpha"}}
	var probes int
	var runner *a2aPolicyHostRunner
	host, fixtureRunner := newA2APolicyHostFixture(t, a2aPolicyFileState{
		PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true,
	}, func(context.Context) (a2aPolicyProcessState, error) {
		current := process
		current.TrustedPeers = append([]string(nil), runner.state.ConfigTrusted...)
		return current, nil
	}, func(_ context.Context, peer, token string, expected A2APeerAccess) (a2aPolicyProbeResult, error) {
		probes++
		if peer != "alpha" || token != a2aPolicyTestTokenA || expected != A2APeerAllow {
			t.Fatal("trusted-peer proof used an unexpected identity, token, or policy")
		}
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeAllowed, code: a2aErrTaskNotFound}, nil
	})
	runner = fixtureRunner

	trusted := true
	status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerTrustMutation, trusted: &trusted})
	if err != nil || !status.Persisted || !status.Effective || status.NeedsGatewayRestart {
		t.Fatal("trust write did not prove the persisted config through the live gateway")
	}
	if probes != 1 || !equalStrings(runner.actions, []string{"read", "trust-set", "read"}) {
		t.Fatal("trust write did not use the fixed config writer, readback, and live probe")
	}
}

func TestA2APolicyReadSeparatesOutgoingRegistrationFromIncomingCredential(t *testing.T) {
	process := a2aPolicyProcessState{Known: true, Running: true, Generation: "gateway-generation", PeerNames: []string{"alpha"}, TrustedPeers: []string{"beta"}}
	host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{
		PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true,
		ConfigTrusted: []string{"beta"}, OutgoingPeers: []a2aOutgoingPeer{{Name: "beta", TokenPresent: true}},
	}, func(context.Context) (a2aPolicyProcessState, error) { return process, nil }, nil)
	view, err := host.Read(context.Background())
	if err != nil || len(view.Peers) != 2 {
		t.Fatal("could not project registered outgoing peer")
	}
	alpha, beta := view.Peers[0], view.Peers[1]
	if !alpha.TokenConfigured || alpha.OutgoingConfigured || alpha.Access != A2APeerDeny || alpha.OutgoingAccess != A2APeerDeny {
		t.Fatal("incoming credential was mistaken for outgoing registration or authorization")
	}
	if beta.TokenConfigured || beta.Access != A2APeerDeny || !beta.OutgoingConfigured || !beta.OutgoingTokenPresent || beta.OutgoingAccess != A2APeerAllow {
		t.Fatal("outgoing credential metadata was mistaken for incoming authentication")
	}
}

func TestA2APolicyOutgoingOnlyTrustRequiresObservedReadback(t *testing.T) {
	var runner *a2aPolicyHostRunner
	host, fixtureRunner := newA2APolicyHostFixture(t, a2aPolicyFileState{
		OutgoingPeers: []a2aOutgoingPeer{{Name: "alpha", TokenPresent: true}},
	}, func(context.Context) (a2aPolicyProcessState, error) {
		return a2aPolicyProcessState{Known: true, Running: true, Generation: "gateway-generation", LocalhostOnly: true, TrustedPeers: append([]string(nil), runner.state.ConfigTrusted...)}, nil
	}, func(context.Context, string, string, A2APeerAccess) (a2aPolicyProbeResult, error) {
		t.Fatal("an outgoing-only registration must not manufacture an incoming credential probe")
		return a2aPolicyProbeResult{}, nil
	})
	runner = fixtureRunner
	trusted := true
	status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerTrustMutation, trusted: &trusted})
	if err != nil || !status.Persisted || !status.Effective || status.NeedsGatewayRestart || !equalStrings(runner.state.ConfigTrusted, []string{"alpha"}) {
		t.Fatal("outgoing peer trust was not proven through current process readback")
	}
}

func TestA2APolicyTrustFileAloneDoesNotProveOutgoingEffect(t *testing.T) {
	host, runner := newA2APolicyHostFixture(t, a2aPolicyFileState{
		OutgoingPeers: []a2aOutgoingPeer{{Name: "alpha"}},
	}, func(context.Context) (a2aPolicyProcessState, error) {
		return a2aPolicyProcessState{Known: true, Running: true, Generation: "gateway-generation", LocalhostOnly: true}, nil
	}, nil)
	trusted := true
	status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerTrustMutation, trusted: &trusted})
	if err != nil || !status.Persisted || status.Effective || !equalStrings(runner.state.ConfigTrusted, []string{"alpha"}) {
		t.Fatal("a saved trust list was mistaken for an observed outgoing policy")
	}
}

func TestProbeMatchRequiresAuthenticatedTrustedPeerDenial(t *testing.T) {
	if probeMatches(a2aPolicyProbeResult{verdict: a2aPolicyProbeDenied, code: a2aErrUnauthorized}, A2APeerDeny) {
		t.Fatal("unauthorized bearer was mistaken for a configured trusted-peer denial")
	}
	if !probeMatches(a2aPolicyProbeResult{verdict: a2aPolicyProbeDenied, code: a2aErrUntrustedPeer}, A2APeerDeny) {
		t.Fatal("authenticated 403 trusted-peer denial was not accepted as proof")
	}
}

func TestA2APolicyHostDeleteRequiresCurrentProcessIdentityEvidence(t *testing.T) {
	t.Run("current process reports absence", func(t *testing.T) {
		call := 0
		host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true}, func(context.Context) (a2aPolicyProcessState, error) {
			call++
			if call == 1 {
				return a2aPolicyProcessState{Known: true, Running: true, Generation: "pid-42:start-7", PeerNames: []string{"alpha"}}, nil
			}
			return a2aPolicyProcessState{Known: true, Running: true, Generation: "pid-43:start-2"}, nil
		}, nil)

		status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerDeleteTokenMutation})
		if err != nil || !status.Persisted || !status.Effective || status.NeedsGatewayRestart {
			t.Fatal("deletion was not proven by the current process's observed peer identities")
		}
	})

	t.Run("identity remains active", func(t *testing.T) {
		process := a2aPolicyProcessState{Known: true, Running: true, Generation: "pid-42:start-7", PeerNames: []string{"alpha"}}
		host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true}, func(context.Context) (a2aPolicyProcessState, error) {
			return process, nil
		}, nil)

		status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerDeleteTokenMutation})
		if err != nil || !status.Persisted || status.Effective || !status.NeedsGatewayRestart {
			t.Fatal("deletion was reported effective while the current process still has the peer token")
		}
	})

	t.Run("new generation with external token override is not proof", func(t *testing.T) {
		call := 0
		host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true}, func(context.Context) (a2aPolicyProcessState, error) {
			call++
			if call == 1 {
				return a2aPolicyProcessState{Known: true, Running: true, Generation: "pid-42:start-7", PeerNames: []string{"alpha"}}, nil
			}
			return a2aPolicyProcessState{Known: true, Running: true, Generation: "pid-43:start-2", PeerTokensOverride: true}, nil
		}, nil)

		status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerDeleteTokenMutation})
		if err != nil || !status.Persisted || status.Effective || !status.NeedsGatewayRestart {
			t.Fatal("a new PID/start with an external token source was mistaken for deletion proof")
		}
	})

	t.Run("unknown or externally overridden process", func(t *testing.T) {
		for _, process := range []a2aPolicyProcessState{
			{},
			{Known: true, Running: true, Generation: "pid-42:start-7", PeerTokensOverride: true},
		} {
			host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true}, func(context.Context) (a2aPolicyProcessState, error) {
				return process, nil
			}, nil)
			status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerDeleteTokenMutation})
			if err == nil || status.Effective {
				t.Fatal("token delete proceeded without an authoritative process token source")
			}
		}
	})
}

func TestA2APolicyProcessSnapshotRequiresGenerationForRunningGateway(t *testing.T) {
	if err := validateA2APolicyProcessState(a2aPolicyProcessState{Known: true, Running: true}); err == nil {
		t.Fatal("running process snapshot without a generation was trusted")
	}
	if err := validateA2APolicyProcessState(a2aPolicyProcessState{Known: true, Running: false}); err != nil {
		t.Fatal("stopped but known process state unexpectedly required a generation")
	}
}

func TestA2APolicyReadUsesObservedAuthenticationAndTrust(t *testing.T) {
	process := a2aPolicyProcessState{
		Known: true, Running: true, Generation: "gateway-generation",
		PeerNames: []string{"alpha", "gamma"}, TrustedPeers: []string{"alpha"},
	}
	host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{
		PeerTokens: "beta:" + a2aPolicyTestTokenA, PeerTokensPresent: true,
		ConfigTrusted: []string{"beta"},
	}, func(context.Context) (a2aPolicyProcessState, error) { return process, nil }, nil)
	view, err := host.Read(context.Background())
	if err != nil || !view.ProcessObserved || view.AccessMode != "trusted_peers" || view.TrustedPeersSource != "config" {
		t.Fatal("the current gateway policy was not identified as observed")
	}
	peers := make(map[string]A2APeerPolicy)
	for _, peer := range view.Peers {
		peers[peer.Identity] = peer
	}
	if len(peers) != 3 || peers["alpha"].Access != A2APeerAllow || peers["gamma"].Access != A2APeerDeny || peers["beta"].Access != A2APeerDeny || peers["beta"].TokenConfigured {
		t.Fatal("pending file state or absent environment override was mistaken for live peer access")
	}
}

func TestA2APolicyReadObservedEmptyTrustDoesNotFallBackToFile(t *testing.T) {
	process := a2aPolicyProcessState{Known: true, Running: true, Generation: "gateway-generation", PeerNames: []string{"alpha"}}
	host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{
		PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true, ConfigTrusted: []string{"beta"},
	}, func(context.Context) (a2aPolicyProcessState, error) { return process, nil }, nil)
	view, err := host.Read(context.Background())
	if err != nil || view.AccessMode != "default_allow" || view.TrustedPeersSource != "none" || view.Peers[0].Access != A2APeerAllow {
		t.Fatal("an observed empty allow-list was replaced by a pending file policy")
	}
	if host.expectedAccess(a2aPolicyFileState{ConfigTrusted: []string{"beta"}}, process, "alpha") != A2APeerAllow {
		t.Fatal("the live probe expectation ignored the observed empty trust list")
	}
}

func TestA2APolicyReadWithoutProcessIsExplicitlyUnobserved(t *testing.T) {
	host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{
		PeerTokens: "alpha:" + a2aPolicyTestTokenA, PeerTokensPresent: true,
	}, nil, nil)
	view, err := host.Read(context.Background())
	if err != nil || view.ProcessObserved {
		t.Fatal("a file-only projection was reported as observed")
	}
}

func TestA2APolicyReadTokenlessModeKeepsUpstreamIPAccessOpen(t *testing.T) {
	process := a2aPolicyProcessState{
		Known: true, Running: true, Generation: "gateway-generation", LocalhostOnly: true,
		TrustedPeers: []string{"ip:127.0.0.2"},
	}
	host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{
		ConfigTrusted: []string{"ip:127.0.0.1"},
	}, func(context.Context) (a2aPolicyProcessState, error) { return process, nil }, nil)
	view, err := host.Read(context.Background())
	if err != nil || view.AccessMode != "localhost_only" || view.Peers[0].Access != A2APeerAllow {
		t.Fatal("tokenless upstream mode was mistaken for an enforced IP trust list")
	}
}

func TestA2APolicyTokenlessProbeCannotProvePendingNamedCredential(t *testing.T) {
	process := a2aPolicyProcessState{Known: true, Running: true, Generation: "gateway-generation", LocalhostOnly: true}
	host, _ := newA2APolicyHostFixture(t, a2aPolicyFileState{}, func(context.Context) (a2aPolicyProcessState, error) { return process, nil }, func(context.Context, string, string, A2APeerAccess) (a2aPolicyProbeResult, error) {
		t.Fatal("tokenless authentication must not be used to prove a named credential")
		return a2aPolicyProbeResult{}, nil
	})
	token := "fixture-pending-peer-token-0123456789abcdef"
	status, err := host.Write(context.Background(), a2aPeerMutation{name: "alpha", kind: a2aPeerTokenMutation, token: &token})
	if err != nil || !status.Persisted || status.Effective || !status.NeedsGatewayRestart {
		t.Fatal("a tokenless request was mistaken for effective named authentication")
	}
}
