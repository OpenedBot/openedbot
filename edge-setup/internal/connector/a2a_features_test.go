package connector

import (
	"encoding/json"
	"testing"
)

func TestA2ACardFeatureDisappearsWhenHostStopsAnnouncingIt(t *testing.T) {
	body := []byte(`{"features":{"a2a_card":true,"hermes_native":true}}`)
	for _, announced := range []bool{false, true} {
		var host []string
		if announced {
			host = []string{FeatureA2ACard}
		}
		var projected struct {
			Features map[string]bool `json:"features"`
		}
		if err := json.Unmarshal(InjectFeatures(body, false, host), &projected); err != nil {
			t.Fatal(err)
		}
		_, present := projected.Features[FeatureA2ACard]
		if present != announced || !projected.Features["hermes_native"] {
			t.Fatalf("host announcement=%v: projected features=%v", announced, projected.Features)
		}
	}
}
