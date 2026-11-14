package commands

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

func browserSidecarRequest(receipt *labBrowserReceipt, action string) map[string]any {
	request := map[string]any{"action": action, "nonce": receipt.Nonce, "profile": receipt.Profile, "runtimeId": receipt.RuntimeID, "version": receipt.Version, "launchedNs": receipt.SidecarRequestedAtNS}
	if receipt.SidecarSpec != nil {
		request["shortTmpDir"] = receipt.SidecarSpec.ShortTmpDir
	}
	return request
}
func saveBrowserObservation(path string, receipt *labBrowserReceipt, deps labBrowserDeps, observed labBrowserSidecarState) error {
	previous := receipt.SidecarState
	if previous != nil && (previous.Unit != observed.Unit || previous.ExecFingerprint != observed.ExecFingerprint) {
		return errors.New("browser sidecar unit or command fingerprint changed")
	}
	if previous != nil && previous.MainPID > 0 {
		if observed.MainPID > 0 && (previous.InvocationID != observed.InvocationID || previous.MainPID != observed.MainPID || previous.StartTicks != observed.StartTicks) {
			return errors.New("browser sidecar process identity changed; refusing to adopt a replacement")
		}
		if observed.MainPID == 0 {
			// An ordinary read can observe inactivity but cannot attest the old PID
			// gone. Only Stop's independent identity check may set Stopped=true.
			known := *previous
			known.Running = false
			known.Stopped = previous.Stopped
			observed = known
		}
	}
	receipt.SidecarState = &observed
	return saveLabBrowser(path, *receipt, deps.Target.Owner)
}
func prepareBrowserSidecar(ctx context.Context, options labMCPOptions, deps labBrowserDeps, path string, receipt *labBrowserReceipt) error {
	if receipt.SidecarSpec == nil {
		if len(receipt.Owned) > 0 {
			return errors.New("remove the legacy local browser fixture before setting up a user-unit fixture")
		}
		spec, err := deps.PlanSidecar(ctx, receipt.Nonce, receipt.ChromiumAsset)
		if err != nil {
			return err
		}
		intent, err := labBrowserSidecarIntent(spec)
		if err != nil {
			return err
		}
		receipt.SidecarSpec, receipt.SidecarState = &spec, &intent
		receipt.SidecarRequestedAtNS = time.Now().UnixNano()
		// The exact fixed unit/command intent is durable before state files or a
		// user service can be created. A lost launch response is reconciled by it.
		if err := saveLabBrowser(path, *receipt, deps.Target.Owner); err != nil {
			return err
		}
	}
	observed, err := deps.InspectSidecar(ctx, *receipt.SidecarSpec)
	if err != nil {
		return err
	}
	if receipt.SidecarState == nil || receipt.SidecarState.MainPID == 0 {
		if !observed.Running {
			if !observed.Stopped {
				return errors.New("browser sidecar is transitioning; retained for reconciliation")
			}
			receipt.SidecarRequestedAtNS = time.Now().UnixNano()
			if err := saveLabBrowser(path, *receipt, deps.Target.Owner); err != nil {
				return err
			}
			request := browserSidecarRequest(receipt, "sidecar-prepare")
			request["resetPort"] = true
			if _, err := deps.Run(ctx, request); err != nil {
				return err
			}
			started, startErr := deps.StartSidecar(ctx, *receipt.SidecarSpec)
			if startErr != nil {
				// Read back only: never send another start after an uncertain reply.
				reconciled, readErr := deps.InspectSidecar(ctx, *receipt.SidecarSpec)
				if readErr == nil && reconciled.Running {
					if err := saveBrowserObservation(path, receipt, deps, reconciled); err != nil {
						return err
					}
				}
				return startErr
			}
			observed = started
		}
	}
	if !observed.Running || !observed.ResourcesVerified || observed.MainPID <= 0 {
		return errors.New("the exact owned browser sidecar is not running with verified resource limits")
	}
	if _, err := deps.Run(ctx, browserSidecarRequest(receipt, "sidecar-ownership")); err != nil {
		return err
	}
	if err := saveBrowserObservation(path, receipt, deps, observed); err != nil {
		return err
	}
	readiness, err := deps.Run(ctx, browserSidecarRequest(receipt, "sidecar-observe"))
	if err != nil {
		return err
	}
	receipt.LastProbeDiagnostic = readiness.ProbeDiagnostic
	if err := saveLabBrowser(path, *receipt, deps.Target.Owner); err != nil {
		return err
	}
	if !validLabBrowserProbe(readiness.ProbeDiagnostic) || readiness.ProbeDiagnostic.Outcome != "succeeded" || !strings.HasPrefix(readiness.CDPURL, "ws://127.0.0.1:") {
		return errors.New("owned sidecar CDP readiness was not proven; inspect private ownership receipt")
	}
	// The service must still be the same incarnation after the HTTP proof.
	after, err := deps.InspectSidecar(ctx, *receipt.SidecarSpec)
	if err != nil {
		return err
	}
	if !after.Running || !after.ResourcesVerified {
		return errors.New("browser sidecar stopped during readiness")
	}
	if err := saveBrowserObservation(path, receipt, deps, after); err != nil {
		return err
	}
	if receipt.SidecarURL != "" && receipt.SidecarURL != readiness.CDPURL {
		return errors.New("owned browser sidecar CDP identity changed")
	}
	receipt.SidecarURL = readiness.CDPURL
	receipt.Owned = browserOwned(receipt.ChromiumAsset)
	receipt.Owned["cdp_url"] = receipt.SidecarURL
	return saveLabBrowser(path, *receipt, deps.Target.Owner)
}

func runLabBrowserLifecycle(ctx context.Context, options labMCPOptions, deps labBrowserDeps, path string, receipt *labBrowserReceipt, replayed bool) (*labBrowserReply, error) {
	reply := func(installed, removed bool) *labBrowserReply {
		return labBrowserResponse(options, receipt, replayed, installed, removed)
	}
	if options.Action == "setup" {
		if receipt.Phase == "removing" || receipt.ConfigRestored {
			return nil, errors.New("finish removing the browser fixture before another setup")
		}
		if receipt.Executable == "" {
			if err := deps.SystemDependencies(ctx); err != nil {
				return nil, fmt.Errorf("install fixed Chromium system dependencies before profile apply: %w", err)
			}
			asset, err := deps.Ensure(ctx)
			if err != nil {
				return nil, err
			}
			receipt.ChromiumAsset = asset
			if err := saveLabBrowser(path, *receipt, deps.Target.Owner); err != nil {
				return nil, err
			}
		}
		if err := prepareBrowserSidecar(ctx, options, deps, path, receipt); err != nil {
			return nil, err
		}
	}
	if options.Action == "receipts" && receipt.SidecarSpec != nil {
		observed, err := deps.InspectSidecar(ctx, *receipt.SidecarSpec)
		if err != nil {
			return nil, err
		}
		ownership := browserSidecarRequest(receipt, "sidecar-ownership")
		ownership["allowRemoved"] = receipt.SidecarState != nil && receipt.SidecarState.Stopped || !observed.Running && observed.Stopped && observed.InvocationID == ""
		if _, err := deps.Run(ctx, ownership); err != nil {
			return nil, err
		}
		if err := saveBrowserObservation(path, receipt, deps, observed); err != nil {
			return nil, err
		}
	}
	if options.Action == "remove" {
		if !receipt.ConfigRestored {
			action := "remove"
			if len(receipt.Owned) == 0 {
				action = "verify-original"
			}
			result, err := deps.Run(ctx, map[string]any{"action": action, "profile": receipt.Profile, "before": receipt.Before, "owned": receipt.Owned})
			if err != nil {
				return nil, err
			}
			if result.Installed == nil || *result.Installed || result.Removed == nil || !*result.Removed {
				return nil, errors.New("browser original configuration restoration was not proven")
			}
			receipt.ConfigRestored, receipt.Phase = true, "removing"
			if err := saveLabBrowser(path, *receipt, deps.Target.Owner); err != nil {
				return nil, err
			}
		}
		if receipt.SidecarSpec != nil {
			if receipt.SidecarState == nil {
				return nil, errors.New("browser sidecar intent is missing")
			}
			ownership := browserSidecarRequest(receipt, "sidecar-ownership")
			allowRemoved := receipt.SidecarState.Stopped
			if receipt.SidecarState.MainPID == 0 {
				current, err := deps.InspectSidecar(ctx, *receipt.SidecarSpec)
				if err != nil {
					return nil, err
				}
				allowRemoved = allowRemoved || !current.Running && current.Stopped && current.InvocationID == ""
			}
			ownership["allowRemoved"] = allowRemoved
			if _, err := deps.Run(ctx, ownership); err != nil {
				return nil, err
			}
			stopped, err := deps.StopSidecar(ctx, *receipt.SidecarSpec, *receipt.SidecarState)
			if err != nil {
				return nil, err
			}
			if stopped.Running || !stopped.Stopped {
				return nil, errors.New("owned browser sidecar stop was not proven")
			}
			if receipt.SidecarState.MainPID > 0 && (stopped.MainPID != receipt.SidecarState.MainPID || stopped.InvocationID != receipt.SidecarState.InvocationID || stopped.StartTicks != receipt.SidecarState.StartTicks || !stopped.ResourcesVerified) {
				return nil, errors.New("browser stop lost its exact observed process identity")
			}
			receipt.SidecarState = &stopped
			if err := saveLabBrowser(path, *receipt, deps.Target.Owner); err != nil {
				return nil, err
			}
			request := browserSidecarRequest(receipt, "sidecar-cleanup")
			request["stopped"] = true
			result, err := deps.Run(ctx, request)
			if err != nil {
				return nil, err
			}
			if result.Removed == nil || !*result.Removed {
				return nil, errors.New("browser sidecar files were not proven removed")
			}
			receipt.SidecarFilesRemoved = true
		}
		receipt.Phase = "removed"
		if err := saveLabBrowser(path, *receipt, deps.Target.Owner); err != nil {
			return nil, err
		}
		return reply(false, true), nil
	}
	if len(receipt.Owned) == 0 {
		return reply(false, false), nil
	}
	result, err := deps.Run(ctx, map[string]any{"action": options.Action, "profile": receipt.Profile, "before": receipt.Before, "owned": receipt.Owned})
	if err != nil {
		return nil, err
	}
	if result.Installed == nil || result.Removed == nil || *result.Removed {
		return nil, errors.New("browser worker omitted configuration observations")
	}
	if options.Action == "setup" && !*result.Installed {
		return nil, errors.New("browser sidecar profile patch was not applied")
	}
	if result.ProfileAbsent {
		receipt.ConfigRestored = true
		receipt.Phase = "removing"
	}
	if *result.Installed {
		receipt.Phase = "installed"
	}
	if err := saveLabBrowser(path, *receipt, deps.Target.Owner); err != nil {
		return nil, err
	}
	return reply(*result.Installed, false), nil
}
