package commands

import (
	"bytes"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
)

func TestExportRefusesJSONAndMD(t *testing.T) {
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb}
	if code := runExport(env, []string{"--json", "--md"}); code != cli.ExitUsage {
		t.Fatalf("--json --md: code=%d err=%q", code, errb.String())
	}
}
