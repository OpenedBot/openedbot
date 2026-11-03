package operator

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

func TestProviderSDKRouteReportsAvailabilityAndAnnouncesFeatureWhenWired(t *testing.T) {
	want := []hermes.ProviderSDKStatus{
		{Provider: "anthropic", Label: "Anthropic", Extra: "anthropic", Installed: true},
		{Provider: "bedrock", Label: "AWS Bedrock", Extra: "bedrock", Installed: false},
	}
	server := &Server{ProviderSDKs: func(context.Context) ([]hermes.ProviderSDKStatus, error) {
		return want, nil
	}}
	status, out := callProviderSDKs(t, server)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body = %v", status, out)
	}
	providers, ok := out["providers"].([]any)
	if !ok || len(providers) != len(want) {
		t.Fatalf("providers = %#v", out["providers"])
	}
	for i, raw := range providers {
		provider, ok := raw.(map[string]any)
		if !ok || provider["provider"] != want[i].Provider || provider["label"] != want[i].Label ||
			provider["extra"] != want[i].Extra || provider["installed"] != want[i].Installed {
			t.Fatalf("provider %d = %#v", i, raw)
		}
	}
	if !slices.Contains(server.features(), "provider_sdks") {
		t.Fatal("provider_sdks was not announced when wired")
	}
	if slices.Contains((&Server{}).features(), "provider_sdks") {
		t.Fatal("provider_sdks was announced without a probe")
	}
}

func TestProviderSDKRouteHidesProbeFailure(t *testing.T) {
	server := &Server{ProviderSDKs: func(context.Context) ([]hermes.ProviderSDKStatus, error) {
		return nil, errors.New("stderr must stay private")
	}}
	status, out := callProviderSDKs(t, server)
	if status != http.StatusServiceUnavailable || errorCode(out) != "PROVIDER_SDK_PROBE_FAILED" {
		t.Fatalf("status = %d, body = %v", status, out)
	}
	if strings.Contains(out["error"].(map[string]any)["message"].(string), "stderr must stay private") {
		t.Fatalf("probe detail leaked: %v", out)
	}
}

func callProviderSDKs(t *testing.T, server *Server) (int, map[string]any) {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/provider-sdks", nil)
	server.Handler().ServeHTTP(response, request)
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response.Code, body
}
