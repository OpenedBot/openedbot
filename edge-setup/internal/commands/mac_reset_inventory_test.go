package commands

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func TestParseMacResetListCollectsManagedInstancesOnly(t *testing.T) {
	listing := "PID Status Label\n" +
		"- 0 com.apple.launchd\n" +
		"- 0 com.openhermesbot.edge-setup.gateway\n" +
		"- 0 com.openhermesbot.edge-setup.operator\n" +
		"401 0 org.example.agent label with spaces\n" +
		"72 -1 com.openhermesbot.edge-setup.connector.zebra\n" +
		"- 0 com.openhermesbot.edge-setup.connector.default\n" +
		"- 0 com.openhermesbot.edge-setup.connector.alpha\n"

	got, err := parseMacResetList(listing)
	if err != nil {
		t.Fatalf("parse list: %v", err)
	}
	want := []layout.ConnectorInstance{
		layout.DefaultConnectorInstance,
		layout.ConnectorInstance("alpha"),
		layout.ConnectorInstance("zebra"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("instances = %#v, want %#v", got, want)
	}
}

func TestParseMacResetListRejectsMalformedOrAmbiguousInventory(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{name: "empty", text: ""},
		{name: "wrong header", text: "PID State Label\n- 0 com.apple.launchd\n"},
		{name: "short row", text: "PID Status Label\n12 0\n"},
		{name: "nonpositive pid", text: "PID Status Label\n0 0 com.apple.launchd\n"},
		{name: "malformed pid", text: "PID Status Label\n12x 0 com.apple.launchd\n"},
		{name: "status outside int32", text: "PID Status Label\n- 2147483648 com.apple.launchd\n"},
		{name: "malformed status", text: "PID Status Label\n- running com.apple.launchd\n"},
		{name: "malformed foreign row after managed row", text: "PID Status Label\n- 0 com.openhermesbot.edge-setup.connector.dev\n- running org.example.agent\n"},
		{name: "unknown managed namespace label", text: "PID Status Label\n- 0 com.openhermesbot.edge-setup.unrelated\n"},
		{name: "invalid managed instance label", text: "PID Status Label\n- 0 com.openhermesbot.edge-setup.connector.Bad\n"},
		{name: "duplicate managed labels", text: "PID Status Label\n- 0 com.openhermesbot.edge-setup.connector.dev\n- 0 com.openhermesbot.edge-setup.connector.dev\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := parseMacResetList(tc.text); err == nil {
				t.Fatalf("accepted malformed inventory with instances %#v", got)
			}
		})
	}
}

func TestParseMacResetListCapsOutputAndManagedJobs(t *testing.T) {
	t.Run("256 managed jobs are accepted", func(t *testing.T) {
		var listing strings.Builder
		listing.WriteString("PID Status Label\n")
		for i := 0; i < 256; i++ {
			fmt.Fprintf(&listing, "- 0 com.openhermesbot.edge-setup.connector.job-%03d\n", i)
		}
		got, err := parseMacResetList(listing.String())
		if err != nil || len(got) != 256 {
			t.Fatalf("accepted-job count=%d err=%v, want 256 jobs", len(got), err)
		}
	})

	t.Run("managed jobs", func(t *testing.T) {
		var listing strings.Builder
		listing.WriteString("PID Status Label\n")
		for i := 0; i < 257; i++ {
			fmt.Fprintf(&listing, "- 0 com.openhermesbot.edge-setup.connector.job-%03d\n", i)
		}
		if _, err := parseMacResetList(listing.String()); err == nil {
			t.Fatal("accepted more than 256 managed connector jobs")
		}
	})

	t.Run("stdout size", func(t *testing.T) {
		listing := "PID Status Label\n" + strings.Repeat("x", 1<<20)
		if _, err := parseMacResetList(listing); err == nil {
			t.Fatal("accepted inventory larger than one MiB")
		}
	})
}

type macResetRunnerReply struct {
	result exec.Result
	err    error
}

type macResetTestRunner struct {
	replies []macResetRunnerReply
	calls   []exec.Cmd
}

func (r *macResetTestRunner) Run(_ context.Context, cmd exec.Cmd) (exec.Result, error) {
	r.calls = append(r.calls, cmd)
	if len(r.replies) == 0 {
		return exec.Result{}, errors.New("unexpected launchctl call")
	}
	reply := r.replies[0]
	r.replies = r.replies[1:]
	return reply.result, reply.err
}

func TestMacResetRegisteredInstancesChecksAquaUIDAndList(t *testing.T) {
	const uid = 501
	const privateTranscript = "private-launchctl-transcript"
	cases := []struct {
		name       string
		replies    []macResetRunnerReply
		wantCalls  int
		wantErr    bool
		wantLabels []layout.ConnectorInstance
	}{
		{
			name: "valid GUI manager and inventory",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n"}},
				{result: exec.Result{Stdout: "Aqua\n"}},
				{result: exec.Result{Stdout: "PID Status Label\n- 0 com.openhermesbot.edge-setup.connector.dev\n"}},
			},
			wantCalls:  3,
			wantLabels: []layout.ConnectorInstance{"dev"},
		},
		{
			name: "wrong manager uid",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "502\n"}},
			},
			wantCalls: 1,
			wantErr:   true,
		},
		{
			name: "manager uid must be unambiguous",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n" + privateTranscript}},
			},
			wantCalls: 1,
			wantErr:   true,
		},
		{
			name: "non Aqua manager",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n"}},
				{result: exec.Result{Stdout: "Background\n"}},
			},
			wantCalls: 2,
			wantErr:   true,
		},
		{
			name: "uid command refusal",
			replies: []macResetRunnerReply{
				{result: exec.Result{ExitCode: 1, Stderr: privateTranscript}},
			},
			wantCalls: 1,
			wantErr:   true,
		},
		{
			name: "uid command stderr on success",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n", Stderr: privateTranscript}},
			},
			wantCalls: 1,
			wantErr:   true,
		},
		{
			name: "manager name refusal",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n"}},
				{result: exec.Result{ExitCode: 1, Stderr: privateTranscript}},
			},
			wantCalls: 2,
			wantErr:   true,
		},
		{
			name: "manager name stderr on success",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n"}},
				{result: exec.Result{Stdout: "Aqua\n", Stderr: privateTranscript}},
			},
			wantCalls: 2,
			wantErr:   true,
		},
		{
			name: "list refusal",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n"}},
				{result: exec.Result{Stdout: "Aqua\n"}},
				{result: exec.Result{ExitCode: 1, Stderr: privateTranscript}},
			},
			wantCalls: 3,
			wantErr:   true,
		},
		{
			name: "list stderr on success",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n"}},
				{result: exec.Result{Stdout: "Aqua\n"}},
				{result: exec.Result{Stdout: "PID Status Label\n", Stderr: privateTranscript}},
			},
			wantCalls: 3,
			wantErr:   true,
		},
		{
			name: "launchctl runner failure",
			replies: []macResetRunnerReply{
				{err: errors.New(privateTranscript)},
			},
			wantCalls: 1,
			wantErr:   true,
		},
		{
			name: "malformed inventory",
			replies: []macResetRunnerReply{
				{result: exec.Result{Stdout: "501\n"}},
				{result: exec.Result{Stdout: "Aqua\n"}},
				{result: exec.Result{Stdout: "PID Status Label\n- 0 com.openhermesbot.edge-setup.unmanaged\n"}},
			},
			wantCalls: 3,
			wantErr:   true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runner := &macResetTestRunner{replies: append([]macResetRunnerReply(nil), tc.replies...)}
			got, err := macResetRegisteredInstances(context.Background(), runner, uid)
			if (err != nil) != tc.wantErr {
				t.Fatalf("error=%v, wantErr=%v", err, tc.wantErr)
			}
			if err == nil && !reflect.DeepEqual(got, tc.wantLabels) {
				t.Fatalf("instances=%#v, want %#v", got, tc.wantLabels)
			}
			if err != nil {
				if strings.Contains(err.Error(), privateTranscript) {
					t.Fatal("launchctl diagnostic transcript escaped into the error")
				}
			}
			if len(runner.calls) != tc.wantCalls {
				t.Fatalf("launchctl calls=%d, want %d", len(runner.calls), tc.wantCalls)
			}
			for i, cmd := range runner.calls {
				if cmd.Path != "/bin/launchctl" || cmd.Timeout != 10*time.Second {
					t.Fatalf("call %d = %#v, want fixed launchctl path and ten second timeout", i, cmd)
				}
			}
			if tc.wantCalls >= 1 && !reflect.DeepEqual(runner.calls[0].Args, []string{"manageruid"}) {
				t.Fatalf("first args=%#v, want manageruid", runner.calls[0].Args)
			}
			if tc.wantCalls >= 2 && !reflect.DeepEqual(runner.calls[1].Args, []string{"managername"}) {
				t.Fatalf("second args=%#v, want managername", runner.calls[1].Args)
			}
			if tc.wantCalls == 3 && !reflect.DeepEqual(runner.calls[2].Args, []string{"list"}) {
				t.Fatalf("third args=%#v, want list", runner.calls[2].Args)
			}
		})
	}
}
