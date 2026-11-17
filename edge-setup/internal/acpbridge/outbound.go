package acpbridge

import (
	"context"
	"encoding/json"
	"time"
)

// Locked state transitions collect outbound work here. The lock exit detaches
// the batch before doing any pipe I/O, including permission and cancel replies.
type agentWrite struct {
	client   *rpcClient
	method   string
	id       json.RawMessage
	value    any
	rpcError *rpcError
	kill     bool
	previous <-chan struct{}
	finished chan struct{}
	deadline time.Time
}

func (b *Bridge) unlockAndSend() error {
	writes := b.outgoing
	b.outgoing = nil
	// Reserve every position before unlocking. A later batch for this client
	// must wait for this batch even if its goroutine reaches the sender first.
	for i := range writes {
		write := &writes[i]
		write.previous = write.client.outboundTail
		write.finished = make(chan struct{})
		write.deadline = time.Now().Add(write.client.writeTimeout)
		write.client.outboundTail = write.finished
	}
	b.mu.Unlock()
	var first error
	for _, write := range writes {

		ctx, cancel := context.WithDeadline(context.Background(), write.deadline)
		var err error
		if write.previous != nil {
			select {
			case <-write.previous:
			case <-ctx.Done():
				err = write.client.failWrite(ctx.Err())
			}
		}
		if err == nil && ctx.Err() != nil {
			err = write.client.failWrite(ctx.Err())
		}
		if err == nil {
			switch {
			case write.kill:
				write.client.kill()
			case write.rpcError != nil:
				err = write.client.write(ctx, rpcMessage{JSONRPC: "2.0", ID: write.id, Error: write.rpcError})
			case write.method != "":
				err = write.client.notify(ctx, write.method, write.value)
			default:
				err = write.client.respond(ctx, write.id, write.value)
			}
		}
		cancel()
		close(write.finished)
		if first == nil {
			first = err
		}
	}
	return first
}
