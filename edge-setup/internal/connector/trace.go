package connector

import (
	"regexp"
	"strings"
)

// TraceparentHeader is the W3C Trace Context header openedbot sets on the
// requests of a run (docs/CONNECTOR.md, « En-têtes »). It is optional both
// ways: openedbot from before it sends none, a connector from before it drops
// it with every header outside ForwardedRequestHeaders, and nothing else
// changes.
const TraceparentHeader = "traceparent"

// traceparentPattern is the version-00 layout, also the first 55 characters
// of any later version.
var traceparentPattern = regexp.MustCompile(`^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})`)

// requestTrace is the trace context of one req frame.
type requestTrace struct {
	// Header is the value relayed to the gateway, as received but trimmed.
	Header  string
	TraceID string
	SpanID  string
}

// parseTraceparent reads one traceparent value the way the W3C
// recommendation asks: an invalid one is ignored, never an error. Version 00
// is exactly 55 characters; a later version (never ff) keeps the 00 layout
// for its first 55 characters and may only continue after a dash. All-zero
// trace or span ids are invalid.
func parseTraceparent(value string) (requestTrace, bool) {
	text := strings.TrimSpace(value)
	m := traceparentPattern.FindStringSubmatch(text)
	if m == nil {
		return requestTrace{}, false
	}
	version, traceID, spanID := m[1], m[2], m[3]
	if version == "ff" {
		return requestTrace{}, false
	}
	if version == "00" && len(text) != 55 {
		return requestTrace{}, false
	}
	if version != "00" && len(text) > 55 && text[55] != '-' {
		return requestTrace{}, false
	}
	if traceID == strings.Repeat("0", 32) || spanID == strings.Repeat("0", 16) {
		return requestTrace{}, false
	}
	return requestTrace{Header: text, TraceID: traceID, SpanID: spanID}, true
}

// traceOf finds the traceparent of a req frame. Header names are
// case-insensitive on the wire: two spellings of it make the frame's trace
// ambiguous, and an ambiguous or malformed trace is dropped (not relayed, not
// journaled) rather than guessed.
func traceOf(headers map[string]string) (requestTrace, bool) {
	var found []string
	for name, value := range headers {
		if strings.EqualFold(name, TraceparentHeader) {
			found = append(found, value)
		}
	}
	if len(found) != 1 {
		return requestTrace{}, false
	}
	return parseTraceparent(found[0])
}

// logRelayTrace journals one traced request after its route passed the
// allowlist: method and path (without the query) are then known-safe, and the
// trace and span ids are hexadecimal only. It is the connector's line of the
// run's end-to-end trail (worker, gateway, connector).
func (c *Client) logRelayTrace(f Text, trace requestTrace) {
	path, _, _ := strings.Cut(f.Path, "?")
	c.Logf("relay %s %s trace=%s span=%s", strings.ToUpper(f.Method), path, trace.TraceID, trace.SpanID)
}
