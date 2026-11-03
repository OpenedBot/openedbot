package hermes

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

func TestProbeProviderSDKsMapsResultsInPinOrder(t *testing.T) {
	python := "/runtime/venv/bin/python"
	fake := exectest.NewFake().OnPrefix(python+" -I -c "+providerSDKProbeScript, exec.Result{
		Stdout: `{"google.auth":true,"boto3":false,"anthropic":true}`,
	})
	statuses, err := ProbeProviderSDKs(context.Background(), fake, python)
	if err != nil {
		t.Fatal(err)
	}
	want := []ProviderSDKStatus{
		{Provider: "anthropic", Label: "Anthropic", Extra: "anthropic", Installed: true, Installable: true},
		{Provider: "bedrock", Label: "AWS Bedrock", Extra: "bedrock", Installed: false},
		{Provider: "vertex", Label: "Google Vertex AI", Extra: "vertex", Installed: true},
	}
	if !reflect.DeepEqual(statuses, want) {
		t.Fatalf("statuses = %#v, want %#v", statuses, want)
	}
	if len(fake.Calls) != 1 || fake.Calls[0].Timeout != 20*time.Second {
		t.Fatalf("probe calls = %#v", fake.Calls)
	}
	args := []string{"-I", "-c", providerSDKProbeScript}
	for _, sdk := range pins.HermesProviderSDKs {
		args = append(args, sdk.Module)
	}
	if !reflect.DeepEqual(fake.Calls[0].Args, args) {
		t.Fatalf("probe args = %#v, want %#v", fake.Calls[0].Args, args)
	}
}

func TestProbeProviderSDKsRejectsFailedOrInvalidOutput(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result exec.Result
		want   string
	}{
		{name: "non-zero exit", result: exec.Result{ExitCode: 2, Stderr: "private diagnostic"}, want: "status 2"},
		{name: "invalid JSON", result: exec.Result{Stdout: "not json"}, want: "parse provider SDK probe output"},
		{name: "missing module", result: exec.Result{Stdout: `{"anthropic":true}`}, want: "omitted module"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			python := "/runtime/venv/bin/python"
			fake := exectest.NewFake().OnPrefix(python+" -I -c "+providerSDKProbeScript, tc.result)
			if _, err := ProbeProviderSDKs(context.Background(), fake, python); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want text %q", err, tc.want)
			}
		})
	}
}

func TestProviderSDKNoticeListsOnlyMissingSDKs(t *testing.T) {
	statuses := []ProviderSDKStatus{
		{Provider: "anthropic", Label: "Anthropic", Extra: "anthropic", Installed: true},
		{Provider: "bedrock", Label: "AWS Bedrock", Extra: "bedrock", Installed: false},
		{Provider: "vertex", Label: "Google Vertex AI", Extra: "vertex", Installed: false},
	}
	want := "provider SDKs not installed (lazy installs are off; runs on these providers fail): AWS Bedrock [bedrock], Google Vertex AI [vertex]"
	if got := ProviderSDKNotice(statuses); got != want {
		t.Fatalf("notice = %q, want %q", got, want)
	}
	if got := MissingProviderSDKs(statuses); !reflect.DeepEqual(got, statuses[1:]) {
		t.Fatalf("missing SDKs = %#v", got)
	}
}

func TestReportProviderSDKsStoresAndLogsOnlyMissingSDKs(t *testing.T) {
	fake := exectest.NewFake().OnPrefix(layout.VenvBin+"/python -I -c "+providerSDKProbeScript, exec.Result{
		Stdout: `{"anthropic":true,"boto3":false,"google.auth":true}`,
	})
	var logs []string
	installer := &Installer{Runner: fake, Log: func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	}}
	var report Report
	installer.reportProviderSDKs(context.Background(), &report)
	wantMissing := []ProviderSDKStatus{{Provider: "bedrock", Label: "AWS Bedrock", Extra: "bedrock", Installed: false}}
	if !reflect.DeepEqual(report.MissingProviderSDKs, wantMissing) {
		t.Fatalf("report missing SDKs = %#v, want %#v", report.MissingProviderSDKs, wantMissing)
	}
	wantNotice := "provider SDKs not installed (lazy installs are off; runs on these providers fail): AWS Bedrock [bedrock]"
	if !reflect.DeepEqual(logs, []string{wantNotice}) {
		t.Fatalf("logs = %#v, want one notice %q", logs, wantNotice)
	}
}

func TestReportProviderSDKsLogsProbeFailureWithoutMarkingInstallFailed(t *testing.T) {
	fake := exectest.NewFake().OnPrefix(layout.VenvBin+"/python -I -c "+providerSDKProbeScript, exec.Result{ExitCode: 1})
	var logs []string
	installer := &Installer{Runner: fake, Log: func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	}}
	var report Report
	installer.reportProviderSDKs(context.Background(), &report)
	if len(report.MissingProviderSDKs) != 0 || !reflect.DeepEqual(logs, []string{"provider SDK probe failed: provider SDK probe exited with status 1"}) {
		t.Fatalf("report = %#v, logs = %#v", report, logs)
	}
}

func TestHermesSyncArgsIncludeEveryPinnedExtra(t *testing.T) {
	project := "/runtime/hermes"
	wantCheck := []string{"sync", "--project", project, "--extra", "all", "--extra", "anthropic", "--locked", "--check"}
	wantSync := []string{"sync", "--project", project, "--extra", "all", "--extra", "anthropic", "--locked"}
	if got := hermesSyncArgs(project, true); !reflect.DeepEqual(got, wantCheck) {
		t.Fatalf("check args = %#v, want %#v", got, wantCheck)
	}
	if got := hermesSyncArgs(project, false); !reflect.DeepEqual(got, wantSync) {
		t.Fatalf("sync args = %#v, want %#v", got, wantSync)
	}
}
