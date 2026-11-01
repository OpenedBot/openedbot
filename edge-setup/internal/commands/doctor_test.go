package commands

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func TestDoctorChecksMultiplexProfiles(t *testing.T) {
	command := hermes.CLI("config", "get", "gateway.multiplex_profiles").String()
	for _, testCase := range []struct {
		name  string
		value exec.Result
		want  bool
	}{
		{name: "enabled", value: exec.Result{Stdout: "true\n"}, want: true},
		{name: "disabled", value: exec.Result{Stdout: "false\n"}, want: false},
		{name: "retired key absent", value: exec.Result{ExitCode: 1, Stderr: "config key not found"}, want: true},
		{name: "command failure", value: exec.Result{ExitCode: 1}, want: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fake := exectest.NewFake()
			fake.On(command, testCase.value)
			if got := multiplexProfilesConfigured(context.Background(), fake); got != testCase.want {
				t.Fatalf("got %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestDoctorNamesAConnectorStoppedOnRefusals(t *testing.T) {
	previous := connectorStateRoot
	connectorStateRoot = t.TempDir()
	defer func() { connectorStateRoot = previous }()
	mac := layout.ConnectorInstance("mac")
	if problem := linkRefusalProblem(mac); problem != "" {
		t.Fatalf("no marker, no problem: %q", problem)
	}
	dir := stateDirOf(mac)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeLinkRefused(dir, errors.New("link refused by openedbot 10 times in a row"), time.Date(2026, 9, 14, 11, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	problem := linkRefusalProblem(mac)
	for _, want := range []string{"hermes-connector@mac.service refused by openedbot since 2026-09-14T11:00:00Z", "10 times in a row", "link --ohb https://… --yes --name mac"} {
		if !strings.Contains(problem, want) {
			t.Fatalf("%q does not contain %q", problem, want)
		}
	}
}

func TestDoctorReportsAMissingLoopbackGuard(t *testing.T) {
	command := "/usr/sbin/iptables -w -S OUTPUT"
	guarded := "-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 0 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 998 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 0 -j ACCEPT\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 9119 -j REJECT --reject-with icmp-port-unreachable\n" +
		"-A OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable\n"
	for _, testCase := range []struct {
		name    string
		value   exec.Result
		problem bool
	}{
		{name: "guarded", value: exec.Result{Stdout: guarded}},
		{name: "unguarded", value: exec.Result{Stdout: "-P OUTPUT ACCEPT\n"}, problem: true},
		{name: "iptables unreadable", value: exec.Result{ExitCode: 1}, problem: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fake := exectest.NewFake()
			fake.On(command, testCase.value)
			problem := loopbackGuardProblem(context.Background(), fake, 998)
			if (problem != "") != testCase.problem {
				t.Fatalf("problem %q, want problem=%v", problem, testCase.problem)
			}
			if len(fake.Calls) != 1 {
				t.Fatalf("doctor reads the rules once, never applies them: %v", fake.Commands())
			}
		})
	}
}
