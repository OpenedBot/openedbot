package operator

import "net/http"

// ACPFeatures is deliberately empty: profile and provider administration are
// not implemented for the experimental engine.
func ACPFeatures() []string { return []string{} }

// ACPHost serves only the capabilities it announces. It constructs none of
// the Hermes dependencies and registers none of their routes.
func ACPHost() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /capabilities", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"features": ACPFeatures()})
	})
	return strictPath(mux)
}
