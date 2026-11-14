package connector

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestTraceE2EHost is the host half of the end-to-end trace proof
// (tests/integration/run-trace-correlation.ts in OpenedBot/openedbot): a real
// connector linked to a real openedbot link gateway, relaying to the fake
// Hermes the harness serves. Every journal line goes to stdout, prefixed
// `connector: `, for the harness to read. It stops on SIGTERM.
//
// It only uses API every published connector has (New, Auth, Logf, Run), so
// the harness can also build it against an older edge-setup tree to prove an
// old connector still links and runs with a newer openedbot.
func TestTraceE2EHost(t *testing.T) {
	linkURL := os.Getenv("OPENEDBOT_TRACE_E2E_WS_URL")
	if linkURL == "" {
		t.Skip("run tests/integration/run-trace-correlation.ts in OpenedBot/openedbot")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	client := New(linkURL, Auth{
		RuntimeID: os.Getenv("OPENEDBOT_TRACE_E2E_RUNTIME_ID"),
		LinkToken: os.Getenv("OPENEDBOT_TRACE_E2E_LINK_TOKEN"),
	}, os.Getenv("OPENEDBOT_TRACE_E2E_GATEWAY_URL"), os.Getenv("OPENEDBOT_TRACE_E2E_BEARER"), nil)
	var mu sync.Mutex
	client.Logf = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(os.Stdout, "connector: "+format+"\n", args...)
	}
	if err := client.Run(ctx); err != nil && ctx.Err() == nil {
		t.Fatalf("connector stopped: %v", err)
	}
}
