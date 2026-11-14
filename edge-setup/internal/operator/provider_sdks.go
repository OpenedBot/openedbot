package operator

import (
	"net/http"

	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
)

// providerSDKs reports provider SDK import availability from the host's
// gateway Python. It accepts no request data and never installs a package.
func (s *Server) providerSDKs(w http.ResponseWriter, r *http.Request) {
	if s.ProviderSDKs == nil {
		writeError(w, http.StatusServiceUnavailable, "PROVIDER_SDK_PROBE_FAILED", "the host could not report provider SDK availability")
		return
	}
	providers, err := s.ProviderSDKs(r.Context())
	if err != nil {
		s.logf("provider SDK probe failed on the host")
		writeError(w, http.StatusServiceUnavailable, "PROVIDER_SDK_PROBE_FAILED", "the host could not report provider SDK availability")
		return
	}
	if providers == nil {
		providers = []hermes.ProviderSDKStatus{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": providers})
}
