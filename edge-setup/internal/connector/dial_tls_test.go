package connector

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

// tlsBroker is a TLS WebSocket endpoint whose server-side TLS version ceiling
// the test chooses.
func tlsBroker(t *testing.T, maxVersion uint16) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"hermes-connector.v1"}})
		if err != nil {
			return
		}
		_ = c.Close(websocket.StatusNormalClosure, "bye")
	}))
	srv.TLS = &tls.Config{MaxVersion: maxVersion}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return srv, pool
}

func dialWith(t *testing.T, srv *httptest.Server, pool *x509.CertPool) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5e9)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(srv.URL, "https"), &websocket.DialOptions{
		HTTPClient:   dialHTTPClientWithRoots(pool),
		Subprotocols: []string{"hermes-connector.v1"},
	})
	if err == nil {
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
	}
	return err
}

// The dial client accepts a broker that speaks TLS 1.3.
func TestDialAcceptsTLS13Broker(t *testing.T) {
	srv, pool := tlsBroker(t, tls.VersionTLS13)
	if err := dialWith(t, srv, pool); err != nil {
		t.Fatalf("TLS 1.3 broker refused: %v", err)
	}
}

// A broker (or a downgrading path) that offers at most TLS 1.2 is refused at
// the handshake: the link is never weakened to an older protocol.
func TestDialRefusesTLS12Broker(t *testing.T) {
	srv, pool := tlsBroker(t, tls.VersionTLS12)
	err := dialWith(t, srv, pool)
	if err == nil {
		t.Fatal("TLS 1.2 broker accepted")
	}
	if !strings.Contains(err.Error(), "protocol version") {
		t.Fatalf("refusal must be a TLS version failure, got: %v", err)
	}
}

// The production dial client has no test roots and pins the TLS 1.3 floor.
func TestDialHTTPClientPinsTLS13Floor(t *testing.T) {
	tr, ok := dialHTTPClient().Transport.(*http.Transport)
	if !ok || tr.TLSClientConfig == nil {
		t.Fatal("dial client has no TLS configuration")
	}
	if tr.TLSClientConfig.MinVersion != tls.VersionTLS13 || tr.TLSClientConfig.RootCAs != nil {
		t.Fatalf("MinVersion=%d RootCAs=%v", tr.TLSClientConfig.MinVersion, tr.TLSClientConfig.RootCAs)
	}
}
