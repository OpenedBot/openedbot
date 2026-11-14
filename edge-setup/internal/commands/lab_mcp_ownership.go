package commands

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

var labMCPChallenge = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func parseLabMCPResult(output string) (labMCPResult, error) {
	var result labMCPResult
	var shape map[string]json.RawMessage
	if len(output) > 32768 || json.Unmarshal([]byte(output), &shape) != nil || len(shape) != 6 {
		return result, errors.New("fixture worker returned malformed bounded evidence")
	}
	for _, key := range []string{"installed", "online", "calls", "removed", "processes", "starts"} {
		if _, ok := shape[key]; !ok {
			return result, errors.New("fixture worker omitted required evidence")
		}
	}
	for _, key := range []string{"installed", "online", "removed"} {
		if string(shape[key]) != "true" && string(shape[key]) != "false" {
			return result, errors.New("fixture worker omitted a boolean observation")
		}
	}
	if json.Unmarshal([]byte(output), &result) != nil || result.Calls == nil || result.Processes == nil || len(result.Calls) > 128 || len(result.Processes) > 32 || result.Starts != len(result.Processes) {
		return result, errors.New("fixture worker returned invalid call/process evidence")
	}
	for _, call := range result.Calls {
		if !labMCPChallenge.MatchString(call.Challenge) {
			return result, errors.New("fixture worker returned an invalid challenge")
		}
	}
	var callRows, processRows []map[string]json.RawMessage
	if json.Unmarshal(shape["calls"], &callRows) != nil || json.Unmarshal(shape["processes"], &processRows) != nil {
		return result, errors.New("fixture worker returned malformed journals")
	}
	for _, row := range callRows {
		if len(row) != 2 || row["challenge"] == nil || (string(row["succeeded"]) != "true" && string(row["succeeded"]) != "false") {
			return result, errors.New("fixture call omitted its result observation")
		}
	}
	for _, row := range processRows {
		if len(row) != 3 || row["pid"] == nil || row["startTicks"] == nil || (string(row["running"]) != "true" && string(row["running"]) != "false") {
			return result, errors.New("fixture process omitted its running observation")
		}
	}
	identities := make(map[labMCPProcess]bool)
	for _, child := range result.Processes {
		identity := child
		identity.Running = false
		if identities[identity] {
			return result, errors.New("fixture worker repeated a process identity")
		}
		identities[identity] = true
		if child.PID <= 0 || child.StartTicks == "" || strings.Trim(child.StartTicks, "0123456789") != "" {
			return result, errors.New("fixture worker returned an invalid process identity")
		}
	}
	return result, nil
}

func executeLabMCP(ctx context.Context, options labMCPOptions, deps labMCPDependencies) (*labMCPReply, error) {
	if !labMCPProfile.MatchString(options.Profile) || !validLabMCPAction(options.Action) {
		return nil, errors.New("invalid owned fixture action or E2E profile")
	}
	if _, err := requireLabTarget(ctx, options.Target, deps.Target); err != nil {
		return nil, err
	}
	info, err := fsx.Lstat(deps.StateDir)
	if err != nil || (info.Exists && (!info.Dir || info.Symlink || info.Owner != deps.Target.Owner || info.Mode != 0o700)) {
		return nil, errors.New("private fixture receipt directory is unsafe")
	}
	if !info.Exists {
		if options.Action != "setup" {
			return nil, errors.New("no owned fixture receipt exists")
		}
		if err := fsx.EnsureDir(deps.StateDir, 0o700, deps.Target.Owner); err != nil {
			return nil, err
		}
	}
	path := filepath.Join(deps.StateDir, options.Target.Nonce+".json")
	data, err := fsx.ReadRegular(path, 0o600, deps.Target.Owner)
	replayed := err == nil
	var receipt *labMCPReceipt
	if errors.Is(err, os.ErrNotExist) && options.Action == "setup" {
		receipt, err = newLabMCPReceipt(options, deps.ScriptPath)
		if err == nil {
			err = saveLabMCPReceipt(path, receipt, deps.Target.Owner)
		}
	} else if err == nil {
		receipt = &labMCPReceipt{}
		err = json.Unmarshal(data, receipt)
	}
	if err != nil || receipt == nil {
		return nil, errors.New("no readable owned fixture receipt exists")
	}
	if receipt.SchemaVersion != 1 || receipt.RuntimeID != options.Target.RuntimeID || receipt.Nonce != options.Target.Nonce || receipt.Profile != options.Profile || receipt.ServerName != "e2e_"+strings.ReplaceAll(options.Target.Nonce, "-", "") {
		return nil, errors.New("the fixture receipt does not own this exact runtime/profile/script entry")
	}
	if receipt.State == "removed" {
		if options.Action != "remove" && options.Action != "receipts" {
			return nil, errors.New("a removed fixture is never recreated or re-enabled")
		}
		return labMCPResponse(options, receipt, true), nil
	}
	if receipt.State != "preparing" && receipt.State != "installed" && receipt.State != "removing" {
		return nil, errors.New("the fixture ownership phase is invalid")
	}
	if receipt.State == "removing" && options.Action == "receipts" {
		return labMCPResponse(options, receipt, true), nil
	}
	if receipt.State == "removing" && options.Action != "remove" {
		return nil, errors.New("fixture removal must finish before another action")
	}
	entryScript := deps.ScriptPath
	if deps.ResolveEntry != nil {
		entryScript, err = deps.ResolveEntry(receipt.EntryHash, receipt.Nonce)
	} else if receipt.EntryHash != labMCPEntryHash(entryScript, receipt.Nonce) {
		err = errors.New("fixture script entry no longer matches")
	}
	if err != nil {
		return nil, err
	}
	if err := deps.Install(); err != nil {
		return nil, err
	}
	run := func(action string) (labMCPResult, error) {
		request := map[string]any{"entryScriptPath": entryScript, "action": action, "runtimeId": receipt.RuntimeID, "nonce": receipt.Nonce, "profile": receipt.Profile, "serverName": receipt.ServerName, "secret": receipt.Secret, "state": receipt.State, "calls": receipt.Calls, "processes": receipt.Processes, "starts": receipt.Starts}
		result, err := deps.Run(ctx, request)
		if err != nil {
			return result, err
		}
		// Journals may append; an earlier proof never disappears or changes.
		if len(result.Calls) < len(receipt.Calls) || !reflect.DeepEqual(result.Calls[:len(receipt.Calls)], receipt.Calls) || result.Starts < receipt.Starts {
			return result, errors.New("fixture evidence moved backwards or changed")
		}
		for index, child := range receipt.Processes {
			if index >= len(result.Processes) || child.PID != result.Processes[index].PID || child.StartTicks != result.Processes[index].StartTicks {
				return result, errors.New("fixture process history changed ownership")
			}
		}
		return result, nil
	}
	if options.Action == "remove" {
		if receipt.State != "removing" {
			result, err := run("remove")
			if err != nil {
				return nil, err
			}
			if result.Installed || result.Online || anyLabMCPChild(result.Processes) {
				return nil, errors.New("fixture entry or stdio child is still active; files retained")
			}
			receipt.labMCPResult, receipt.State = result, "removing"
			// Final challenge receipts are durable BEFORE mutable files disappear.
			if err := saveLabMCPReceipt(path, receipt, deps.Target.Owner); err != nil {
				return nil, err
			}
		}
		result, err := run("cleanup")
		if err != nil {
			return nil, err
		}
		if !result.Removed || result.Installed || result.Online || anyLabMCPChild(result.Processes) {
			return nil, errors.New("fixture cleanup was not proven")
		}
		receipt.labMCPResult, receipt.State = result, "removed"
	} else {
		result, err := run(options.Action)
		if err != nil {
			return nil, err
		}
		if options.Action == "setup" && (!result.Installed || result.Removed) {
			return nil, errors.New("fixture setup did not prove its profile entry")
		}
		if options.Action == "online" && (!result.Installed || !result.Online) {
			return nil, errors.New("fixture did not become online")
		}
		if options.Action == "offline" && (!result.Installed || result.Online) {
			return nil, errors.New("fixture did not become offline")
		}
		receipt.labMCPResult = result
		if options.Action == "setup" {
			receipt.State = "installed"
		}
	}
	if err := saveLabMCPReceipt(path, receipt, deps.Target.Owner); err != nil {
		return nil, err
	}
	return labMCPResponse(options, receipt, replayed), nil
}

func anyLabMCPChild(children []labMCPProcess) bool {
	for _, child := range children {
		if child.Running {
			return true
		}
	}
	return false
}
func saveLabMCPReceipt(path string, receipt *labMCPReceipt, owner fsx.Owner) error {
	body, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, body, 0o600, owner)
}
func labMCPResponse(options labMCPOptions, receipt *labMCPReceipt, replayed bool) *labMCPReply {
	response := &labMCPReply{SchemaVersion: 1, Kind: "mcp-fixture", Action: options.Action, RuntimeID: receipt.RuntimeID, Nonce: receipt.Nonce, Profile: receipt.Profile, ServerName: receipt.ServerName, ToolName: "mcp__" + receipt.ServerName + "__read_probe", Replayed: replayed, labMCPResult: receipt.labMCPResult}
	if options.Action == "setup" {
		response.Secret = receipt.Secret
	}
	return response
}
