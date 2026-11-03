package connector

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"time"

	"github.com/coder/websocket"
)

// InventoryPollInterval is how often the connector asks its operator for the
// inventory fingerprint. The read is a stat walk of a few config files and
// SKILL.md entries, in Go, never a Python interpreter: a few milliseconds.
const InventoryPollInterval = 5 * time.Second

// inventoryRetryInterval spaces the reads after a failure (operator
// restarting, socket gone), so a broken operator is not polled every tick.
const inventoryRetryInterval = 30 * time.Second

// readInventoryFingerprint reads GET /inventory/fingerprint on the operator.
// supported is false when the operator predates the route (404): the
// connector then stops polling, and openedbot, which never receives a signal,
// keeps bounding the age of its snapshot.
func (c *Client) readInventoryFingerprint(parent context.Context) (fingerprint string, supported bool, err error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", "http://hermes-operator/inventory/fingerprint", nil)
	if err != nil {
		return "", false, err
	}
	resp, err := c.operatorClient().Do(req)
	if err != nil {
		return "", true, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", true, errInventoryStatus(resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if err != nil {
		return "", true, err
	}
	var doc struct {
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.Unmarshal(body, &doc); err != nil || doc.Fingerprint == "" {
		return "", true, errInventoryBody
	}
	return doc.Fingerprint, true, nil
}

type inventoryError string

func (e inventoryError) Error() string { return string(e) }

const errInventoryBody = inventoryError("the operator returned no inventory fingerprint")

func errInventoryStatus(status int) error {
	return inventoryError("the operator answered the inventory fingerprint with HTTP " + http.StatusText(status))
}

// acceptsInventoryChanged reports whether link.context lists inventory.changed.
func acceptsInventoryChanged(f Text) bool {
	return slices.Contains(f.Accepts, TInventoryChanged)
}

// watchInventory sends inventory.changed once at start (what changed while the
// link was down is unknown) and then whenever the fingerprint moves. It ends
// with the session, or when the operator stops serving the route.
func (c *Client) watchInventory(ctx context.Context, send func(websocket.MessageType, []byte) error) {
	interval := c.InventoryPollInterval
	if interval <= 0 {
		interval = InventoryPollInterval
	}
	frame, err := EncodeText(Text{T: TInventoryChanged})
	if err != nil {
		return
	}
	last, delay, failing := "", time.Duration(0), false
	for c.wait(ctx, delay) == nil {
		delay = interval
		fingerprint, supported, err := c.readInventoryFingerprint(ctx)
		if !supported {
			c.Logf("inventory watch stopped: the operator does not serve the inventory fingerprint")
			return
		}
		if err != nil {
			if !failing && ctx.Err() == nil {
				c.Logf("inventory fingerprint unavailable: %v; retrying", err)
			}
			failing, delay = true, inventoryRetryInterval
			continue
		}
		failing = false
		if fingerprint == last {
			continue
		}
		if err := send(websocket.MessageText, frame); err != nil {
			// The session is ending: the next one starts with a signal anyway.
			return
		}
		last = fingerprint
	}
}
