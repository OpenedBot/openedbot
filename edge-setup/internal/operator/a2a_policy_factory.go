package operator

import "context"

// wireA2APolicyServer receives only installed host configuration. No relay
// request can select its interpreter, runtime home, listener or operation.
func wireA2APolicyServer(server *Server, cfg a2aPolicyHostConfig) {
	policy, err := newA2APolicyHost(cfg)
	if err != nil || cfg.ObserveProcess == nil {
		return
	}
	server.A2APeers = policy.Read
	server.A2APolicyReady = func(ctx context.Context) bool {
		state, err := cfg.ObserveProcess(ctx)
		return err == nil && state.Known && state.Running
	}
	server.WriteA2APeer = func(ctx context.Context, mutation a2aPeerMutation) (a2aPolicyWriteStatus, error) {
		// These existing writers share config.yaml or .env. Serialize our fixed
		// policy writer with them to preserve unrelated credentials and settings.
		server.credBusy.Lock()
		defer server.credBusy.Unlock()
		server.toolsetBusy.Lock()
		defer server.toolsetBusy.Unlock()
		server.mcpBusy.Lock()
		defer server.mcpBusy.Unlock()
		status, err := policy.Write(ctx, mutation)
		if status.Persisted && status.NeedsGatewayRestart {
			server.markGatewayRestartPending()
		}
		return status, err
	}
}

func hostA2APolicyProver(cfg a2aPolicyHostConfig) a2aPolicyPeerProver {
	return func(ctx context.Context, peer, token string, expected A2APeerAccess) (a2aPolicyProbeResult, error) {
		return probeA2APeerPolicy(ctx, peer, token, expected, a2aPolicyProbeDeps{
			Doer:      a2aCardHTTPClient,
			ProveBind: func(ctx context.Context) error { return proveA2ALoopbackListener(ctx, cfg.Runner) },
			AppendDeny: func(_ context.Context, receipt A2APolicyDenialReceipt) error {
				return appendA2APolicyProbeReceipt(cfg.RuntimeRoot, receipt.Peer, receipt.TaskID)
			},
			NewTaskID: newA2APolicyProbeID,
		})
	}
}
