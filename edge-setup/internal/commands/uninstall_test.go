package commands

import (
	"bytes"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
)

func TestUninstallDataChoice(t *testing.T) {
	for _, c := range []struct {
		input string
		purge bool
		err   string
	}{
		{"\n", false, ""},
		{"1\n", false, ""},
		{"2\npurge\n", true, ""},
		{"2\nyes\n", false, "purge not confirmed"},
		{"2\n", false, "no answer"},
		{"3\n", false, "unknown choice"},
		{"", false, "no answer"},
	} {
		var out bytes.Buffer
		purge, err := askDataChoice(strings.NewReader(c.input), &out)
		if purge != c.purge || (err == nil) != (c.err == "") || err != nil && !strings.Contains(err.Error(), c.err) {
			t.Errorf("input %q: purge=%v err=%v, want purge=%v err~%q", c.input, purge, err, c.purge, c.err)
		}
	}
}

func TestUninstallRefusesContradictoryDataFlagsBeforeAnything(t *testing.T) {
	for _, c := range []struct {
		args []string
		code int
	}{
		{[]string{"--yes", "--keep-data", "--purge-data", "--i-understand-data-loss"}, cli.ExitUsage},
		{[]string{"--yes", "--purge-data"}, cli.ExitRefused},
	} {
		var out, errb bytes.Buffer
		if code := runUninstall(cli.Env{Version: "test", Stdout: &out, Stderr: &errb}, c.args); code != c.code {
			t.Errorf("%v: code=%d want %d err=%q", c.args, code, c.code, errb.String())
		}
	}
}
