package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/enroll"
)

// Production connector; deliberately synthetic inference and persistence. This
// host is controlled only by the isolated TypeScript separation E2E harness.
func TestSeparatedGatewayE2EHost(t *testing.T) {
	linkURL, controlURL := os.Getenv("OPENEDBOT_LINK_E2E_WS_URL"), os.Getenv("OPENEDBOT_LINK_E2E_CONTROL_URL")
	if linkURL == "" || controlURL == "" {
		t.Skip("run apps/api/tests/runtime-link-separation.e2e.test.ts in OpenedBot/openedbot")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	var mu sync.Mutex
	counts := map[string]int{}
	gates := map[string]chan struct{}{}
	gate := func(id string) chan struct{} {
		mu.Lock()
		defer mu.Unlock()
		if gates[id] == nil {
			gates[id] = make(chan struct{})
		}
		return gates[id]
	}
	finished := make(chan struct{})
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		switch {
		case r.URL.Path == "/test/state":
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewEncoder(w).Encode(counts)
		case r.URL.Path == "/test/release" && r.Method == "POST":
			ch := gate(id)
			select {
			case <-ch:
			default:
				close(ch)
			}
			w.WriteHeader(204)
		case r.URL.Path == "/test/finish" && r.Method == "POST":
			select {
			case <-finished:
			default:
				close(finished)
			}
			w.WriteHeader(204)
		case r.URL.Path == "/health":
			_, _ = w.Write([]byte(`{"status":"ok","synthetic":true}`))
		case r.URL.Path == "/v1/runs" && r.Method == "POST":
			var body struct {
				ID string `json:"id"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || body.ID == "" {
				http.Error(w, "invalid test payload", 400)
				return
			}
			mu.Lock()
			counts[body.ID]++
			mu.Unlock()
			select {
			case <-gate(body.ID):
				_ = json.NewEncoder(w).Encode(map[string]string{"run_id": body.ID})
			case <-r.Context().Done():
			}
		case strings.HasSuffix(r.URL.Path, "/events"):
			id = strings.Split(r.URL.Path, "/")[3]
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: run.delta\ndata: {\"seq\":1}\n\n")
			w.(http.Flusher).Flush()
			select {
			case <-gate(id):
				fmt.Fprint(w, "event: run.completed\ndata: {\"seq\":2}\n\n")
			case <-r.Context().Done():
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer host.Close()
	client := New(linkURL, Auth{RuntimeID: "5f0f8a3a-1111-4222-8333-444455556666", LinkToken: "continuity-test-token"}, host.URL, "", nil)
	// The TypeScript harness may seed a device key the way systemd would:
	// with it the host proves possession, without it the broker journals
	// pop_missing. Both are legitimate fixtures; a malformed seed is not.
	if credDir := os.Getenv("CREDENTIALS_DIRECTORY"); credDir != "" {
		if seed, err := os.ReadFile(filepath.Join(credDir, "device.key")); err == nil {
			deviceKey, err := enroll.ParseDeviceSeed(seed)
			if err != nil {
				t.Fatalf("device.key credential: %v", err)
			}
			client.DeviceKey = deviceKey
		}
	}
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	defer func() { cancel(); <-done }()
	request, _ := http.NewRequestWithContext(ctx, "POST", controlURL+"/host-ready", strings.NewReader(fmt.Sprintf(`{"url":%q}`, host.URL)))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatalf("control registration status %d", response.StatusCode)
	}
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("isolated harness did not finish")
	}
}
