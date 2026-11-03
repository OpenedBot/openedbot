// Package exectest holds the scripted exec.Runner double used by tests, kept
// out of the exec package so it is not part of the production binary's API.
package exectest

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

// Fake is a scripted exec.Runner for tests. Responses are matched by exact
// command string first, then by prefix; unmatched commands fail loudly so a
// test cannot silently succeed on a command it never described.
type Fake struct {
	mu        sync.Mutex
	responses map[string]exec.Result
	sequences map[string][]exec.Result
	prefixes  []prefixResponse
	Calls     []exec.Cmd
	// Default, when set, answers unmatched commands instead of failing.
	Default *exec.Result
}

type prefixResponse struct {
	prefix string
	res    exec.Result
}

// NewFake returns an empty fake.
func NewFake() *Fake { return &Fake{responses: map[string]exec.Result{}} }

// On scripts an exact command string ("path arg arg").
func (f *Fake) On(command string, res exec.Result) *Fake {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.responses[command] = res
	return f
}

// OnSequence scripts successive answers for one exact command string; the
// last one answers every later call. A step that repairs what it proved wrong
// and proves it again runs the same command twice, with two outcomes.
func (f *Fake) OnSequence(command string, results ...exec.Result) *Fake {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sequences == nil {
		f.sequences = map[string][]exec.Result{}
	}
	f.sequences[command] = append(f.sequences[command], results...)
	return f
}

// OnPrefix scripts every command starting with prefix.
func (f *Fake) OnPrefix(prefix string, res exec.Result) *Fake {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prefixes = append(f.prefixes, prefixResponse{prefix: prefix, res: res})
	return f
}

// Run implements Runner.
func (f *Fake) Run(_ context.Context, c exec.Cmd) (exec.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, c)
	key := c.String()
	if queued, ok := f.sequences[key]; ok && len(queued) > 0 {
		res := queued[0]
		if len(queued) > 1 {
			f.sequences[key] = queued[1:]
		}
		return res, nil
	}
	if res, ok := f.responses[key]; ok {
		return res, nil
	}
	for _, p := range f.prefixes {
		if strings.HasPrefix(key, p.prefix) {
			return p.res, nil
		}
	}
	if f.Default != nil {
		return *f.Default, nil
	}
	return exec.Result{}, fmt.Errorf("fake runner: unscripted command %q", key)
}

// Ran reports whether a command with this exact string was run.
func (f *Fake) Ran(command string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.Calls {
		if c.String() == command {
			return true
		}
	}
	return false
}

// Commands returns every command string run so far, in order.
func (f *Fake) Commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.Calls))
	for _, c := range f.Calls {
		out = append(out, c.String())
	}
	return out
}
