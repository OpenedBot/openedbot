package operator

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// Every write verb must say whether it rewrites a config.yaml: an
// unclassified one would run without the lock and lose a concurrent change.
func TestEveryProbeWriteVerbIsClassifiedForTheConfigLock(t *testing.T) {
	for verb := range probeVerbs {
		if cacheableVerbs[verb] || parameterizedReadVerbs[verb] {
			continue
		}
		n := 0
		for _, set := range []map[string]bool{configRootWriteVerbs, configProfileWriteVerbs, configNeutralWriteVerbs} {
			if set[verb] {
				n++
			}
		}
		if n != 1 {
			t.Errorf("%s is in %d of the config lock sets, want exactly 1", verb, n)
		}
	}
}

func TestConfigWriteTargets(t *testing.T) {
	for _, tc := range []struct {
		verb    string
		request any
		want    []string
	}{
		{"mcp-add", map[string]any{"name": "github"}, []string{rootConfig}},
		{"profile-model-set", map[string]any{"name": "scout", "provider": "p"}, []string{"scout"}},
		{"profile-models-set", map[string]any{"names": []string{"b", "a"}}, []string{"b", "a"}},
		{"profile-memory-write", map[string]any{"name": "scout"}, nil},
	} {
		got := configWriteTargets(tc.verb, tc.request)
		if len(got) != len(tc.want) {
			t.Errorf("%s: %q, want %q", tc.verb, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("%s: %q, want %q", tc.verb, got, tc.want)
			}
		}
	}
}

// Two writers of the same config.yaml never overlap, whichever route they
// come from (a single model change, a batch that names the profile, an MCP
// toggle); writers of different files still run side by side.
func TestConfigWritesOfOneFileAreSerialised(t *testing.T) {
	var mu sync.Mutex
	active := map[string]int{}
	overlap := map[string]bool{}
	parallel, peak := 0, 0
	s := &Server{Probe: func(ctx context.Context, verb string, request []byte) ([]byte, error) {
		targets := map[string][]string{
			`{"name":"scout"}`:            {"scout"},
			`{"name":"other"}`:            {"other"},
			`{"names":["other","scout"]}`: {"other", "scout"},
		}[string(request)]
		mu.Lock()
		for _, k := range targets {
			active[k]++
			if active[k] > 1 {
				overlap[k] = true
			}
		}
		parallel++
		peak = max(peak, parallel)
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		parallel--
		for _, k := range targets {
			active[k]--
		}
		mu.Unlock()
		return []byte(`{}`), nil
	}}
	calls := []struct {
		verb    string
		request any
	}{
		{"profile-model-set", map[string]any{"name": "scout"}},
		{"profile-mcp-set", map[string]any{"name": "scout"}},
		{"profile-memory-set", map[string]any{"name": "scout"}},
		{"profile-models-set", map[string]any{"names": []string{"other", "scout"}}},
		{"profile-skill-set", map[string]any{"name": "other"}},
		{"profile-toolset-suppress", map[string]any{"name": "other"}},
	}
	var wg sync.WaitGroup
	for range 3 {
		for _, c := range calls {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := s.runProbe(context.Background(), c.verb, c.request, nil); err != nil {
					t.Error(err)
				}
			}()
		}
	}
	wg.Wait()
	if len(overlap) != 0 {
		t.Fatalf("concurrent writes of the same config: %v", overlap)
	}
	if peak < 2 {
		t.Fatalf("writes of different configs never ran side by side (peak %d)", peak)
	}
}

func TestConfigLockWaitEndsWithTheContext(t *testing.T) {
	s := &Server{}
	unlock, err := s.lockConfigs(context.Background(), "scout")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	// "alpha" sorts first and is taken, then released when "scout" times out.
	if _, err := s.lockConfigs(ctx, "scout", "alpha"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	again, err := s.lockConfigs(context.Background(), "alpha")
	if err != nil {
		t.Fatal(err)
	}
	again()
	unlock()
	if relock, err := s.lockConfigs(context.Background(), "scout"); err != nil {
		t.Fatal(err)
	} else {
		relock()
	}
}
