package sandbox

import "testing"

func TestMaxConcurrentRuns(t *testing.T) {
	for _, c := range []struct {
		m    Machine
		want int
	}{
		{Machine{VCPUs: 2, MemTotalMB: 8192}, 4},  // cpu 4, ram 11 → 4
		{Machine{VCPUs: 8, MemTotalMB: 4096}, 3},  // cpu 16, ram 3 → 3
		{Machine{VCPUs: 1, MemTotalMB: 2048}, 1},  // ram negative → 1
		{Machine{VCPUs: 4, MemTotalMB: 32768}, 8}, // cpu 8, ram 59 → 8
	} {
		if got := MaxConcurrentRuns(c.m); got != c.want {
			t.Errorf("%+v: %d, want %d", c.m, got, c.want)
		}
	}
}

func TestSettingsPinTheContract(t *testing.T) {
	s := Settings(Machine{VCPUs: 2, MemTotalMB: 8192})
	want := map[string]string{
		"terminal.backend":                       "docker",
		"terminal.docker_image":                  "nikolaik/python-nodejs:python3.11-nodejs20@sha256:8f958bdc1b4a422bfafd97cab4f69836401f616ae985d4b57a53d254f5bcb038",
		"terminal.container_cpu":                 "0.5",
		"terminal.container_memory":              "512",
		"terminal.container_persistent":          "false",
		"terminal.docker_network":                "true",
		"terminal.lifetime_seconds":              "300",
		"terminal.timeout":                       "180",
		"terminal.sandbox_dir":                   "/srv/hermes/data/sandboxes",
		"terminal.docker_volumes":                `["/srv/hermes/data/workspaces:/workspace"]`,
		"gateway.api_server.max_concurrent_runs": "4",
	}
	if len(s) != len(want) {
		t.Fatalf("%d settings", len(s))
	}
	for _, kv := range s {
		if want[kv.Key] != kv.Value {
			t.Errorf("%s = %q, want %q", kv.Key, kv.Value, want[kv.Key])
		}
	}
}

func TestSameValue(t *testing.T) {
	if !SameValue("terminal.docker_volumes", `["/srv/hermes/data/workspaces:/workspace"]`, `["/srv/hermes/data/workspaces:/workspace"]`) {
		t.Fatal("equal lists")
	}
	if SameValue("terminal.docker_volumes", `[]`, `["/x:/workspace"]`) {
		t.Fatal("different lists")
	}
	if !SameValue("terminal.container_persistent", "False", "false") {
		t.Fatal("case-insensitive scalars")
	}
}

func TestCheckRootlessKitNetwork(t *testing.T) {
	docker29 := "rootlesskit --state-dir=/run/user/999/dockerd-rootless --net=slirp4netns --mtu=65520 --slirp4netns-sandbox=auto --slirp4netns-seccomp=auto --disable-host-loopback --port-driver=builtin --copy-up=/etc --copy-up=/run --propagation=rslave --detach-netns /usr/bin/dockerd-rootless.sh"
	if err := checkRootlessKitNetwork(docker29); err != nil {
		t.Fatalf("docker 29 rootless command line refused: %v", err)
	}
	cases := map[string]string{
		"pasta":               "rootlesskit --net=pasta --disable-host-loopback /usr/bin/dockerd-rootless.sh",
		"vpnkit":              "rootlesskit --net vpnkit --disable-host-loopback /usr/bin/dockerd-rootless.sh",
		"host loopback open":  "rootlesskit --net=slirp4netns --port-driver=builtin /usr/bin/dockerd-rootless.sh",
		"no network argument": "rootlesskit /usr/bin/dockerd-rootless.sh",
	}
	for name, cmdline := range cases {
		if err := checkRootlessKitNetwork(cmdline); err == nil {
			t.Errorf("%s: %q accepted", name, cmdline)
		}
	}
}
