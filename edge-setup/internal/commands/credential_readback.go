package commands

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

// Use the same effective pool as `hermes auth list`, including upstream's
// singleton/env synchronization and profile fallback. Only labels leave the
// child process; no credential body or auth.json transcript is printed.
//
//go:embed credential_labels.py
var credentialLabelsProgram string

func proveCredentialRemoved(ctx context.Context, r exec.Runner, h runtimeCLI, provider, label string) error {
	if !providerRe.MatchString(provider) || !labelRe.MatchString(label) || h.Python == nil {
		return errors.New("credential removal proof input is invalid")
	}
	cmd := h.Python("-c", credentialLabelsProgram, provider)
	cmd.Timeout = 15 * time.Second
	result, err := r.Run(ctx, cmd)
	if err != nil || result.ExitCode != 0 || strings.TrimSpace(result.Stderr) != "" || len(result.Stdout) > 256<<10 {
		return errors.New("credential pool could not be read back; removal is unverified")
	}
	var doc struct {
		Labels []*string `json:"labels"`
	}
	decoder := json.NewDecoder(strings.NewReader(result.Stdout))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&doc); err != nil || doc.Labels == nil {
		return errors.New("credential pool readback is invalid; removal is unverified")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("credential pool readback is invalid; removal is unverified")
	}
	for _, remaining := range doc.Labels {
		if remaining == nil {
			return errors.New("credential pool readback is invalid; removal is unverified")
		}
		if *remaining == label {
			return errors.New("credential label still appears in the effective pool; removal is unverified")
		}
	}
	return nil
}
