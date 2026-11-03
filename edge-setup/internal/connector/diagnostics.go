package connector

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/coder/websocket"
)

const DiagnosticQueueLimit = 128
const diagnosticFileLimit = 2 << 20

type diagnosticState struct {
	Last   map[string]bool `json:"last"`
	Events []Text          `json:"events"`
}

// DiagnosticSpool survives an openedbot outage and process restart. Only acknowledged
// events are removed; the oldest event is evicted at the explicit 128-event cap.
type DiagnosticSpool struct {
	mu    sync.Mutex
	path  string
	state diagnosticState
}

// Re-enrolling a host must not replay the previous runtime's incidents into
// another runtime or openedbot organization. Hashing also keeps paths unambiguous.
func NewRuntimeDiagnosticSpool(dir, runtimeID, wsURL string) (*DiagnosticSpool, error) {
	if runtimeID == "" || wsURL == "" {
		return nil, errors.New("diagnostic spool requires a runtime binding")
	}
	binding := sha256.Sum256([]byte(wsURL + "\n" + runtimeID))
	return NewDiagnosticSpool(filepath.Join(dir, fmt.Sprintf("%x", binding)))
}

func NewDiagnosticSpool(dir string) (*DiagnosticSpool, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &DiagnosticSpool{path: filepath.Join(dir, "pending.json"), state: diagnosticState{Last: map[string]bool{}}}
	f, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, diagnosticFileLimit+1))
	if err != nil || len(b) > diagnosticFileLimit {
		return nil, errors.New("diagnostic spool exceeds its read limit")
	}
	if err := json.Unmarshal(b, &s.state); err != nil {
		return nil, errors.New("invalid diagnostic spool")
	}
	if len(s.state.Events) > DiagnosticQueueLimit || len(s.state.Last) > 2 {
		return nil, errors.New("diagnostic spool exceeds its entry limit")
	}
	if s.state.Last == nil {
		s.state.Last = map[string]bool{}
	}
	for _, event := range s.state.Events {
		b, _ := EncodeText(event)
		if _, err := DecodeText(b); err != nil || event.T != TDiagnostic {
			return nil, errors.New("invalid diagnostic event in spool")
		}
	}
	return s, nil
}

func (s *DiagnosticSpool) persist() error {
	b, err := json.Marshal(s.state)
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(s.path, b, 0o600, fsx.Current())
}

// Record never receives an arbitrary error message, URL, token or run content.
// The reporting stack contains function/file/line only, never arguments/locals.
func (s *DiagnosticSpool) Record(component string, available bool, code, stack string, now time.Time) (bool, error) {
	if component != "link" && component != "operator" {
		return false, errors.New("invalid diagnostic component")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, exists := s.state.Last[component]
	if (exists && previous == available) || (!exists && available) {
		s.state.Last[component] = available
		return false, nil
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return false, err
	}
	id[6], id[8] = (id[6]&0x0f)|0x40, (id[8]&0x3f)|0x80
	event := Text{
		T: TDiagnostic, EventID: fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]),
		Component: component, State: "unavailable", Code: code,
		OccurredAt: now.UTC().Format(time.RFC3339Nano), Message: diagnosticMessage(code), Stack: stack,
	}
	if available {
		event.State, event.Stack = "recovered", ""
	}
	b, _ := EncodeText(event)
	if _, err := DecodeText(b); err != nil {
		return false, err
	}
	s.state.Last[component] = available
	dropped := len(s.state.Events) == DiagnosticQueueLimit
	if dropped {
		s.state.Events = s.state.Events[1:]
	}
	s.state.Events = append(s.state.Events, event)
	return dropped, s.persist()
}

func (s *DiagnosticSpool) Pending() []Text {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Text(nil), s.state.Events[:min(4, len(s.state.Events))]...)
}

func (s *DiagnosticSpool) Ack(eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, event := range s.state.Events {
		if event.EventID != eventID {
			continue
		}
		previous := s.state.Events
		s.state.Events = append(append([]Text(nil), previous[:i]...), previous[i+1:]...)
		if err := s.persist(); err != nil {
			s.state.Events = previous
			return err
		}
		break
	}
	return nil
}

func reportingStack() string {
	pcs := make([]uintptr, 24)
	n := runtime.Callers(2, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	var out strings.Builder
	out.WriteString("Reporting stack (no arguments or local values):\n")
	for {
		frame, more := frames.Next()
		line := fmt.Sprintf("%s\n  %s:%d\n", frame.Function, filepath.Base(frame.File), frame.Line)
		if out.Len()+len(line) > 8192 {
			break
		}
		out.WriteString(line)
		if !more {
			break
		}
	}
	return out.String()
}

type diagnosticError struct {
	err   error
	code  string
	stack string
}

func (e *diagnosticError) Error() string { return e.err.Error() }
func (e *diagnosticError) Unwrap() error { return e.err }

func reportableError(err error, code string) error {
	if err == nil {
		return nil
	}
	if code == "LINK_DIAL_FAILED" || code == "LINK_CLOSED" {
		var dns *net.DNSError
		var timeout net.Error
		var authority x509.UnknownAuthorityError
		switch {
		case errors.Is(err, io.EOF):
			code = "LINK_EOF"
		case errors.Is(err, syscall.ECONNRESET):
			code = "LINK_CONNECTION_RESET"
		case errors.Is(err, syscall.ECONNREFUSED):
			code = "LINK_CONNECTION_REFUSED"
		case errors.As(err, &dns):
			code = "LINK_DNS_FAILED"
		case errors.As(err, &authority):
			code = "LINK_TLS_UNTRUSTED"
		case errors.As(err, &timeout) && timeout.Timeout():
			code = "LINK_CONNECT_TIMEOUT"
		}
	}
	return &diagnosticError{err: err, code: code, stack: reportingStack()}
}

func diagnosticMessage(code string) string {
	switch code {
	case "LINK_EOF":
		return "The openedbot WebSocket transport closed while reading a frame (EOF)."
	case "LINK_CONNECTION_RESET":
		return "The openedbot connection was reset by the peer."
	case "LINK_CONNECTION_REFUSED":
		return "The openedbot endpoint refused the connection."
	case "LINK_DNS_FAILED":
		return "The openedbot endpoint name could not be resolved."
	case "LINK_TLS_UNTRUSTED":
		return "The openedbot TLS certificate could not be trusted."
	case "LINK_CONNECT_TIMEOUT":
		return "The openedbot connection timed out."
	case "LINK_DIAL_FAILED":
		return "The connector could not open the openedbot WebSocket."
	case "LINK_PONG_TIMEOUT":
		return "openedbot did not answer the WebSocket keepalive."
	case "LINK_AUTH_REFUSED":
		return "openedbot refused the link credentials."
	case "LINK_REVOKED":
		return "openedbot revoked the link."
	case "LINK_REPLACED":
		return "Another connection replaced this link."
	case "LINK_RECOVERED":
		return "The connector received an openedbot frame again."
	case "OPERATOR_RECOVERED":
		return "The host operator answered the capability probe."
	case "OPERATOR_NOT_READY":
		return "The host operator did not become ready within 15 seconds."
	default:
		return "The openedbot WebSocket session ended."
	}
}

func (c *Client) reportHealth(component string, available bool, err error) {
	// Attempt durable recording before making the transition available to the
	// Discord sender. A disk failure still allows the independent alert.
	defer c.Health(component, available)
	if c.Diagnostics == nil {
		return
	}
	code, stack := "LINK_CLOSED", ""
	if available {
		code = strings.ToUpper(component) + "_RECOVERED"
	} else {
		stack = reportingStack()
		var diagnostic *diagnosticError
		if errors.As(err, &diagnostic) {
			code, stack = diagnostic.code, diagnostic.stack
		}
		var closed websocket.CloseError
		if errors.As(err, &closed) {
			switch closed.Code {
			case CloseUnauth:
				code = "LINK_AUTH_REFUSED"
			case CloseRevoked:
				code = "LINK_REVOKED"
			case CloseReplaced:
				code = "LINK_REPLACED"
			}
		}
		if component == "operator" {
			code = "OPERATOR_NOT_READY"
		}
	}
	dropped, writeErr := c.Diagnostics.Record(component, available, code, stack, time.Now())
	if dropped {
		c.Logf("diagnostic spool full: oldest pending event dropped (limit 128)")
	}
	if writeErr != nil {
		c.Logf("diagnostic spool write failed; pending events retained in memory")
	}
}

// No delivery is attempted while disconnected. The first broker frame starts
// this loop; missing ACKs cause bounded replay, never a connector restart.
func (c *Client) sendDiagnostics(ctx context.Context, send sender) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		for _, event := range c.Diagnostics.Pending() {
			b, err := EncodeText(event)
			if err != nil || send(websocket.MessageText, b) != nil {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
