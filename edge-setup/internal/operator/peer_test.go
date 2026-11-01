package operator

import (
	"errors"
	"testing"
)

const (
	connectorCgroup  = "0::/system.slice/hermes-connector.service\n"
	instanceCgroup   = "0::/system.slice/system-hermes\\x2dconnector.slice/hermes-connector@main.service\n"
	instanceNoSlice  = "0::/system.slice/hermes-connector@main.service\n"
	otherSlice       = "0::/system.slice/system-hermes\\x2dgateway.slice/hermes-gateway@x.service\n"
	gatewayCgroup    = "0::/system.slice/hermes-gateway.service\n"
	dockerUserCgroup = "0::/user.slice/user-999.slice/user@999.service/app.slice/docker.service\n"
	fakeUserUnit     = "0::/user.slice/user-999.slice/user@999.service/app.slice/hermes-connector.service\n"
	nestedFake       = "0::/system.slice/hermes-gateway.service/system.slice/hermes-connector.service\n"
	v1Connector      = "12:pids:/system.slice/hermes-connector.service\n1:name=systemd:/system.slice/hermes-connector.service\n"
	v1Gateway        = "12:pids:/system.slice/hermes-connector.service\n1:name=systemd:/system.slice/hermes-gateway.service\n"
)

func testPolicy() PeerPolicy {
	return PeerPolicy{ServiceUID: 999, ServiceGID: 999, Units: []string{"hermes-connector", "hermes-connector@"}}
}

func cgroupOf(body string) func(int) ([]byte, error) {
	return func(int) ([]byte, error) { return []byte(body), nil }
}

func TestPeerPolicy(t *testing.T) {
	unreadable := func(int) ([]byte, error) { return nil, errors.New("gone") }
	cases := []struct {
		name   string
		cred   PeerCred
		cgroup func(int) ([]byte, error)
		ok     bool
	}{
		{"root from anywhere", PeerCred{PID: 1, UID: 0, GID: 0}, unreadable, true},
		{"root with another gid", PeerCred{PID: 7, UID: 0, GID: 999}, nil, true},
		{"connector unit", PeerCred{PID: 42, UID: 999, GID: 999}, cgroupOf(connectorCgroup), true},
		{"connector template instance", PeerCred{PID: 42, UID: 999, GID: 999}, cgroupOf(instanceCgroup), true},
		{"connector template instance without its slice", PeerCred{PID: 42, UID: 999, GID: 999}, cgroupOf(instanceNoSlice), true},
		{"another template's instance", PeerCred{PID: 42, UID: 999, GID: 999}, cgroupOf(otherSlice), false},
		{"connector on a cgroup v1 host", PeerCred{PID: 42, UID: 999, GID: 999}, cgroupOf(v1Connector), true},
		{"gateway, same uid", PeerCred{PID: 43, UID: 999, GID: 999}, cgroupOf(gatewayCgroup), false},
		{"gateway on v1, unified-looking pids line", PeerCred{PID: 43, UID: 999, GID: 999}, cgroupOf(v1Gateway), false},
		{"rootless docker in the user manager", PeerCred{PID: 44, UID: 999, GID: 999}, cgroupOf(dockerUserCgroup), false},
		{"user unit named like the connector", PeerCred{PID: 45, UID: 999, GID: 999}, cgroupOf(fakeUserUnit), false},
		{"connector name nested under the gateway", PeerCred{PID: 46, UID: 999, GID: 999}, cgroupOf(nestedFake), false},
		{"service uid, foreign gid", PeerCred{PID: 42, UID: 999, GID: 100}, cgroupOf(connectorCgroup), false},
		{"another uid in the group", PeerCred{PID: 42, UID: 1000, GID: 999}, cgroupOf(connectorCgroup), false},
		{"cgroup unreadable", PeerCred{PID: 42, UID: 999, GID: 999}, unreadable, false},
		{"no pid", PeerCred{PID: 0, UID: 999, GID: 999}, cgroupOf(connectorCgroup), false},
		{"empty cgroup", PeerCred{PID: 42, UID: 999, GID: 999}, cgroupOf(""), false},
		{"prefix lookalike", PeerCred{PID: 42, UID: 999, GID: 999}, cgroupOf("0::/system.slice/hermes-connector-evil.service\n"), false},
	}
	for _, tc := range cases {
		err := testPolicy().Allow(tc.cred, tc.cgroup)
		if (err == nil) != tc.ok {
			t.Errorf("%s: Allow = %v, want ok=%v", tc.name, err, tc.ok)
		}
		if err != nil && !errors.Is(err, errPeerRefused) {
			t.Errorf("%s: error %v is not errPeerRefused", tc.name, err)
		}
	}
}

func TestUnresolvedServiceUserAdmitsRootOnly(t *testing.T) {
	policy := PeerPolicy{ServiceUID: -1, ServiceGID: -1, Units: []string{"hermes-connector"}}
	if err := policy.Allow(PeerCred{PID: 9, UID: 0}, nil); err != nil {
		t.Fatalf("root refused: %v", err)
	}
	for _, uid := range []int{-1, 1, 999} {
		if err := policy.Allow(PeerCred{PID: 9, UID: uid, GID: -1}, cgroupOf(connectorCgroup)); err == nil {
			t.Fatalf("uid %d admitted without a resolved service user", uid)
		}
	}
}
