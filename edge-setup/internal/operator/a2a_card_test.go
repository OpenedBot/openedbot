package operator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const validA2ACardJSON = `{"name":"Hermes Probe","description":"bounded card description","url":"http://127.0.0.1:9900/","version":"1.0.0","provider":{"organization":"DROP_PROVIDER"},"supportedInterfaces":[{"url":"http://127.0.0.1:9900/","protocolBinding":"JSONRPC","protocolVersion":"1.0","tenant":"DROP_TENANT"}],"capabilities":{"streaming":true,"pushNotifications":true,"extendedAgentCard":false},"securitySchemes":{"bearer":{"type":"http","scheme":"bearer","token":"DROP_SECRET"}},"security":[{"bearer":[]}],"skills":[{"id":"toolset.web","name":"web","description":"bounded skill","tags":["web","search"],"examples":["DROP_EXAMPLE"]}],"unknown":"DROP_UNKNOWN"}`

func TestParseA2ACardProjectsOnlyBoundedMetadata(t *testing.T) {
	card, err := parseA2ACard([]byte(validA2ACardJSON))
	if err != nil {
		t.Fatal(err)
	}
	if card.Name != "Hermes Probe" || card.Version != "1.0.0" || len(card.SupportedInterfaces) != 1 {
		t.Fatalf("unexpected card projection: %+v", card)
	}
	iface := card.SupportedInterfaces[0]
	if iface.URL != "http://127.0.0.1:9900/" || iface.ProtocolBinding != "JSONRPC" || iface.ProtocolVersion != "1.0" {
		t.Fatalf("unexpected interface projection: %+v", iface)
	}
	if !card.Capabilities.Streaming || !card.Capabilities.PushNotifications || len(card.Skills) != 1 || card.Skills[0].Name != "web" {
		t.Fatalf("unexpected capabilities or skills: %+v", card)
	}
	encoded, err := jsonMarshal(card)
	if err != nil {
		t.Fatal(err)
	}
	for _, omitted := range []string{"DROP_PROVIDER", "DROP_TENANT", "DROP_SECRET", "DROP_EXAMPLE", "DROP_UNKNOWN", "securitySchemes", "\"security\""} {
		if strings.Contains(string(encoded), omitted) {
			t.Fatalf("projection retained %q: %s", omitted, encoded)
		}
	}
}

func TestParseA2ACardRejectsMalformedOrUnboundedFields(t *testing.T) {
	cases := map[string]string{
		"not json":                     "not-json",
		"trailing value":               validA2ACardJSON + ` {}`,
		"duplicate name":               strings.Replace(validA2ACardJSON, `"name":"Hermes Probe"`, `"name":"Hermes Probe","name":"other"`, 1),
		"missing name":                 strings.Replace(validA2ACardJSON, `"name":"Hermes Probe",`, "", 1),
		"missing interface":            strings.Replace(validA2ACardJSON, `"supportedInterfaces":[{"url":"http://127.0.0.1:9900/","protocolBinding":"JSONRPC","protocolVersion":"1.0","tenant":"DROP_TENANT"}]`, `"supportedInterfaces":[]`, 1),
		"unsupported binding":          strings.Replace(validA2ACardJSON, `"protocolBinding":"JSONRPC"`, `"protocolBinding":"HTTP+JSON"`, 1),
		"unsupported protocol version": strings.Replace(validA2ACardJSON, `"protocolVersion":"1.0"`, `"protocolVersion":"2.0"`, 1),
		"url with credentials":         strings.Replace(validA2ACardJSON, `http://127.0.0.1:9900/`, `http://user:pass@127.0.0.1:9900/`, 1),
		"url with query":               strings.Replace(validA2ACardJSON, `http://127.0.0.1:9900/`, `http://127.0.0.1:9900/?token=x`, 1),
		"newline in display name":      strings.Replace(validA2ACardJSON, `"Hermes Probe"`, `"Hermes\nProbe"`, 1),
		"oversized body":               strings.Repeat(" ", maxA2ACard+1),
		"too many skills":              strings.Replace(validA2ACardJSON, `"skills":[{"id":"toolset.web","name":"web","description":"bounded skill","tags":["web","search"],"examples":["DROP_EXAMPLE"]}]`, `"skills":[`+strings.Repeat(`{"id":"x","name":"x"},`, maxA2ASkills)+`{"id":"x","name":"x"}]`, 1),
		"too many tags":                strings.Replace(validA2ACardJSON, `"tags":["web","search"]`, `"tags":[`+strings.TrimSuffix(strings.Repeat(`"x",`, maxA2ATags+1), ",")+`]`, 1),
		"oversized skill description":  strings.Replace(validA2ACardJSON, `bounded skill`, strings.Repeat("x", 257), 1),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseA2ACard([]byte(body)); err == nil {
				t.Fatal("expected card validation failure")
			}
		})
	}
}

type a2aDoerFunc func(*http.Request) (*http.Response, error)

func (f a2aDoerFunc) Do(request *http.Request) (*http.Response, error) { return f(request) }

func a2aResponse(status int, contentType, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestFetchA2ACardUsesFixedLoopbackAndProvesBindBeforeAndAfter(t *testing.T) {
	proofCalls := 0
	requestCalls := 0
	card, err := fetchA2ACard(context.Background(), a2aDoerFunc(func(request *http.Request) (*http.Response, error) {
		requestCalls++
		if request.Method != http.MethodGet || request.URL.String() != "http://127.0.0.1:9900/.well-known/agent-card.json" || request.URL.RawQuery != "" {
			t.Fatalf("request escaped its fixed endpoint: %s %s", request.Method, request.URL)
		}
		return a2aResponse(http.StatusOK, "application/json; charset=utf-8", validA2ACardJSON), nil
	}), func(context.Context) error {
		proofCalls++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if card.Name != "Hermes Probe" || requestCalls != 1 || proofCalls != 2 {
		t.Fatalf("card=%+v requests=%d bind checks=%d", card, requestCalls, proofCalls)
	}
}

func TestFetchA2ACardFailsClosedWhenLoopbackBindingIsNotProven(t *testing.T) {
	requestCalls := 0
	_, err := fetchA2ACard(context.Background(), a2aDoerFunc(func(*http.Request) (*http.Response, error) {
		requestCalls++
		return a2aResponse(http.StatusOK, "application/json", validA2ACardJSON), nil
	}), func(context.Context) error { return errors.New("wildcard listener") })
	if err == nil || requestCalls != 0 {
		t.Fatalf("expected fail-closed bind proof, err=%v requests=%d", err, requestCalls)
	}
}

func TestFetchA2ACardRejectsRedirectsStatusAndUnboundedResponses(t *testing.T) {
	cases := []struct {
		name     string
		response *http.Response
	}{
		{name: "redirect", response: a2aResponse(http.StatusFound, "application/json", validA2ACardJSON)},
		{name: "wrong content type", response: a2aResponse(http.StatusOK, "text/html", validA2ACardJSON)},
		{name: "oversized response", response: a2aResponse(http.StatusOK, "application/json", strings.Repeat("x", maxA2ACard+1))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := fetchA2ACard(context.Background(), a2aDoerFunc(func(*http.Request) (*http.Response, error) {
				return tc.response, nil
			}), func(context.Context) error { return nil })
			if err == nil {
				t.Fatal("expected bounded response refusal")
			}
		})
	}
}

func TestA2ACapabilityIsAnnouncedOnlyWhenCardAndLoopbackProofWork(t *testing.T) {
	for _, tc := range []struct {
		name      string
		reader    func(context.Context) (A2AAgentCard, error)
		announced bool
	}{
		{name: "missing reader", reader: nil, announced: false},
		{name: "unavailable plugin", reader: func(context.Context) (A2AAgentCard, error) { return A2AAgentCard{}, errors.New("offline") }, announced: false},
		{name: "valid card and loopback", reader: func(context.Context) (A2AAgentCard, error) { return A2AAgentCard{Name: "Hermes"}, nil }, announced: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{A2ACard: tc.reader}
			srv := httptest.NewServer(s.Handler())
			defer srv.Close()
			_, body := call(t, srv, http.MethodGet, "/capabilities", "")
			if got := containsString(body["features"], A2ACardFeature); got != tc.announced {
				t.Fatalf("a2a_card announced=%v want %v, body=%v", got, tc.announced, body)
			}
		})
	}
}

func TestA2ACardOperatorRouteIsNamedReadOnlyAndHasNoParameters(t *testing.T) {
	s := &Server{A2ACard: func(context.Context) (A2AAgentCard, error) {
		return A2AAgentCard{Name: "Hermes", Version: "1.0.0"}, nil
	}}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	status, body := call(t, srv, http.MethodGet, "/a2a/agent-card", "")
	if status != http.StatusOK || body["name"] != "Hermes" {
		t.Fatalf("card read returned %d %v", status, body)
	}
	status, _ = call(t, srv, http.MethodGet, "/a2a/agent-card?path=/other", "")
	if status != http.StatusBadRequest {
		t.Fatalf("query input returned HTTP %d", status)
	}
	status, _ = call(t, srv, http.MethodPost, "/a2a/agent-card", "{}")
	if status != http.StatusNotFound {
		t.Fatalf("POST returned HTTP %d", status)
	}
	status, _ = call(t, srv, http.MethodGet, "/a2a/jsonrpc", "")
	if status != http.StatusNotFound {
		t.Fatalf("generic A2A path returned HTTP %d", status)
	}
}

func TestA2ACardUnavailableHidesHostFailureDetails(t *testing.T) {
	s := &Server{A2ACard: func(context.Context) (A2AAgentCard, error) {
		return A2AAgentCard{}, errors.New("sentinel-private-listener-detail")
	}}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	status, body := call(t, srv, http.MethodGet, "/a2a/agent-card", "")
	if status != http.StatusServiceUnavailable || strings.Contains(fmt.Sprint(body), "sentinel-private-listener-detail") {
		t.Fatalf("host failure leaked or returned unexpected status %d: %v", status, body)
	}
}

func jsonMarshal(value any) ([]byte, error) {
	return json.Marshal(value)
}
