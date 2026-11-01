package operator

import (
	"context"
	"io"
	"net/http"
)

type a2aPolicyReader func(context.Context) (A2APolicyView, error)
type a2aPolicyWriter func(context.Context, a2aPeerMutation) (a2aPolicyWriteStatus, error)

type a2aPolicyWriteStatus struct {
	Persisted           bool `json:"persisted"`
	Effective           bool `json:"effective"`
	NeedsGatewayRestart bool `json:"needsGatewayRestart"`
}

// a2aPolicyListHandler is mounted at GET /a2a/peers. The reader is injected
// so this file has no dependency on OS-specific Server fields.
func a2aPolicyListHandler(read a2aPolicyReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			writeError(w, http.StatusBadRequest, "A2A_INPUT_INVALID", "the A2A peer inventory accepts no query parameters")
			return
		}
		if read == nil {
			writeError(w, http.StatusServiceUnavailable, "A2A_POLICY_UNAVAILABLE", "A2A peer policy is not available on this host")
			return
		}
		view, err := read(r.Context())
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "A2A_POLICY_UNAVAILABLE", "the local A2A peer policy could not be read safely")
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}

// a2aPolicyTrustHandler is mounted at POST /a2a/peers/{peer}/trust.
func a2aPolicyTrustHandler(write a2aPolicyWriter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			writeError(w, http.StatusBadRequest, "A2A_INPUT_INVALID", "the A2A peer trust write accepts no query parameters")
			return
		}
		body, ok := readA2APolicyBody(w, r)
		if !ok {
			return
		}
		mutation, err := decodeA2APeerTrustMutation(r.PathValue("peer"), body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "A2A_PEER_INVALID", "the named A2A peer trust request is invalid")
			return
		}
		dispatchA2APolicyWrite(w, r, write, mutation)
	}
}

// a2aPolicyTokenHandler is mounted at POST /a2a/peers/{peer}/token.
func a2aPolicyTokenHandler(write a2aPolicyWriter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			writeError(w, http.StatusBadRequest, "A2A_INPUT_INVALID", "the A2A peer token write accepts no query parameters")
			return
		}
		body, ok := readA2APolicyBody(w, r)
		if !ok {
			return
		}
		mutation, err := decodeA2APeerTokenMutation(r.PathValue("peer"), body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "A2A_PEER_INVALID", "the named A2A peer token request is invalid")
			return
		}
		dispatchA2APolicyWrite(w, r, write, mutation)
	}
}

// a2aPolicyTokenDeleteHandler is mounted at DELETE /a2a/peers/{peer}/token.
func a2aPolicyTokenDeleteHandler(write a2aPolicyWriter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			writeError(w, http.StatusBadRequest, "A2A_INPUT_INVALID", "the A2A peer token delete accepts no query parameters")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
		if err != nil || len(body) != 0 {
			writeError(w, http.StatusBadRequest, "A2A_INPUT_INVALID", "the A2A peer token delete accepts no body")
			return
		}
		mutation, err := decodeA2APeerTokenDeleteMutation(r.PathValue("peer"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "A2A_PEER_INVALID", "the named A2A peer token request is invalid")
			return
		}
		dispatchA2APolicyWrite(w, r, write, mutation)
	}
}

func readA2APolicyBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the A2A peer policy body is missing or too large")
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(body) > MaxBody {
		writeError(w, http.StatusBadRequest, "BODY_INVALID", "the A2A peer policy body is missing or too large")
		return nil, false
	}
	return body, true
}

func dispatchA2APolicyWrite(w http.ResponseWriter, r *http.Request, write a2aPolicyWriter, mutation a2aPeerMutation) {
	if write == nil {
		writeError(w, http.StatusServiceUnavailable, "A2A_POLICY_UNAVAILABLE", "A2A peer policy is not available on this host")
		return
	}
	status, err := write(r.Context(), mutation)
	if err != nil {
		writeError(w, http.StatusBadGateway, "A2A_POLICY_UNVERIFIED", "the A2A peer policy write could not be verified")
		return
	}
	if status.Effective && (!status.Persisted || status.NeedsGatewayRestart) {
		writeError(w, http.StatusBadGateway, "A2A_POLICY_UNVERIFIED", "the A2A peer policy write could not be verified")
		return
	}
	code := http.StatusOK
	if !status.Effective {
		if !status.Persisted || !status.NeedsGatewayRestart {
			writeJSON(w, http.StatusBadGateway, status)
			return
		}
		code = http.StatusAccepted
	}
	writeJSON(w, code, status)
}
