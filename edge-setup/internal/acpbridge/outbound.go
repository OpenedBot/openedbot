package acpbridge

import (
	"context"
	"encoding/json"
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
}

func (b *Bridge) unlockAndSend() error {
	writes := b.outgoing
	b.outgoing = nil
	b.mu.Unlock()
	var first error
	for _, write := range writes {
		var err error
		switch {
		case write.kill:
			write.client.kill()
		case write.rpcError != nil:
			err = write.client.write(context.Background(), rpcMessage{JSONRPC: "2.0", ID: write.id, Error: write.rpcError})
		case write.method != "":
			err = write.client.notify(write.method, write.value)
		default:
			err = write.client.respond(write.id, write.value)
		}
		if first == nil {
			first = err
		}
	}
	return first
}
