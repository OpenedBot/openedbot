package operator

import (
	"context"
	"slices"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
)

func TestApprovalPolicyFeatureRequiresBothVerbs(t *testing.T) {
	if !slices.Contains(connector.HostFeatures, connector.FeatureApprovalPolicy) {
		t.Fatal("approval policy feature is missing from the connector's known host feature order")
	}
	server := &Server{ApprovalPolicyRead: func(_ context.Context, _ string) (approvalPolicyState, error) { return approvalPolicyState{}, nil }}
	if slices.Contains(server.features(), "approval_policy") {
		t.Fatal("approval policy was announced without its write verb")
	}
	server.ApprovalPolicyWrite = func(_ context.Context, _ string, request approvalPolicyRequest) (approvalPolicyState, error) {
		return approvalPolicyState{Mode: request.Mode, PluginEnabled: true}, nil
	}
	if !slices.Contains(server.features(), "approval_policy") {
		t.Fatal("approval policy was not announced when both verbs were wired")
	}
}
