//go:build linux

package operator

import "testing"

func TestParseProcA2AListenersRequiresOnlyLoopbackSockets(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
		fail bool
	}{
		{name: "ipv4 loopback", body: procHeader + "0: 0100007F:26AC 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n", want: true},
		{name: "ipv6 loopback", body: procHeader + "0: 00000000000000000000000001000000:26AC 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n", want: true},
		{name: "ipv4 wildcard", body: procHeader + "0: 00000000:26AC 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n", fail: true},
		{name: "ipv6 wildcard", body: procHeader + "0: 00000000000000000000000000000000:26AC 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n", fail: true},
		{name: "loopback plus wildcard", body: procHeader + "0: 0100007F:26AC 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n1: 00000000:26AC 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 2\n", fail: true},
		{name: "no socket", body: procHeader, want: false},
		{name: "different port", body: procHeader + "0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n", want: false},
		{name: "non-listening socket", body: procHeader + "0: 0100007F:26AC 00000000:0000 01 00000000:00000000 00:00000000 00000000 0 0 1\n", want: false},
		{name: "missing table header", body: "0: 0100007F:26AC 00000000:0000 0A\n", fail: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseProcA2AListeners([]byte(tc.body))
			if tc.fail {
				if err == nil {
					t.Fatal("expected listener proof failure")
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got=%v err=%v, want=%v", got, err, tc.want)
			}
		})
	}
}

const procHeader = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
