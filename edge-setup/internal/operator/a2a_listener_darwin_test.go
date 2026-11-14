//go:build darwin

package operator

import "testing"

func TestParseLsofA2AListenersRequiresOnlyLoopbackSockets(t *testing.T) {
	cases := []struct {
		name string
		body string
		fail bool
	}{
		{name: "ipv4 loopback", body: "p12\nn127.0.0.1:9900\n"},
		{name: "ipv6 loopback", body: "p12\nn[::1]:9900 (LISTEN)\n"},
		{name: "wildcard", body: "p12\nn*:9900\n", fail: true},
		{name: "ipv6 wildcard", body: "p12\nn[::]:9900\n", fail: true},
		{name: "loopback plus wildcard", body: "p12\nn127.0.0.1:9900\np13\nn*:9900\n", fail: true},
		{name: "no listener", body: "p12\n", fail: true},
		{name: "malformed address", body: "p12\nnbad\n", fail: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := parseLsofA2AListeners([]byte(tc.body))
			if tc.fail && err == nil {
				t.Fatal("expected listener proof failure")
			}
			if !tc.fail && err != nil {
				t.Fatal(err)
			}
		})
	}
}
