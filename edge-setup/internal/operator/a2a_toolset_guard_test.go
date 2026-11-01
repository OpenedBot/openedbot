package operator

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
)

func TestManagedA2AToolsetRequiresGuardForRootAndProfiles(t *testing.T) {
	for _, path := range []string{"/toolsets/a2a", "/profiles/scout/toolsets/a2a"} {
		t.Run(path, func(t *testing.T) {
			fake := exectest.NewFake().OnPrefix("/usr/sbin/runuser -u hermes -- /usr/bin/env", exec.Result{})
			recorder := &probeRecorder{replies: map[string]string{
				"toolsets": `{"platform":"api_server","settable":["a2a","web"]}`,
			}}
			s := &Server{Runner: fake, Probe: recorder.probe(), Inventory: func(context.Context) ([]byte, error) {
				return []byte(`{"data":[{"name":"a2a","enabled":true}]}`), nil
			}}
			srv := httptest.NewServer(s.Handler())
			t.Cleanup(srv.Close)
			ready := false
			s.A2APolicyReady = func(context.Context) bool { return ready }
			status, body := call(t, srv, "POST", path, `{"enabled":true}`)
			if status != 403 || errorCode(body) != "A2A_POLICY_UNAVAILABLE" || len(fake.Calls) != 0 {
				t.Fatal("unguarded A2A reached a native toolset write")
			}
			ready = true
			status, body = call(t, srv, "POST", path, `{"enabled":true}`)
			if status != 200 || body["enabled"] != true || body["applied"] != true || len(fake.Calls) != 1 {
				t.Fatal("guarded A2A did not reach the native write and inventory proof")
			}
			ready = false
			status, _ = call(t, srv, "POST", path, `{"enabled":false}`)
			if status != 200 || len(fake.Calls) != 2 {
				t.Fatal("disabling A2A incorrectly required a running guard")
			}
		})
	}
}
