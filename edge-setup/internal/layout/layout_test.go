package layout

import "testing"

func TestParseConnectorInstanceGrammar(t *testing.T) {
	for _, ok := range []string{"", "dev", "a", "prod-eu-1", "x0"} {
		if _, err := ParseConnectorInstance(ok); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"Dev", "1dev", "-dev", "dev_1", "dev.json", "../x", "a b", "abcdefghijklmnopqrstuvwxyz0123456", "default", "runs", "diagnostics", "creation-audit"} {
		if _, err := ParseConnectorInstance(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// The default instance keeps the pre-existing names: a provisioned host must
// not see its unit or files move.
func TestConnectorInstancePaths(t *testing.T) {
	d := DefaultConnectorInstance
	if d.LinkPath() != ConnectorLink || d.DeviceKeyPath() != ConnectorDeviceKey || d.Unit() != ConnectorUnit || d.StateDir() != ConnectorStateDir || d.Label() != "default" {
		t.Fatalf("default instance moved: %s %s %s %s", d.LinkPath(), d.DeviceKeyPath(), d.Unit(), d.StateDir())
	}
	n := ConnectorInstance("dev")
	for got, want := range map[string]string{
		n.LinkPath():         "/etc/hermes/connector/dev/link.json",
		n.DeviceKeyPath():    "/etc/hermes/connector/dev/device.key.cred",
		n.Unit():             "hermes-connector@dev",
		n.StateDir():         "/var/lib/hermes-connector/dev",
		n.Label():            "dev",
		n.DirUnder("/tmp/x"): "/tmp/x/dev",
	} {
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
}
