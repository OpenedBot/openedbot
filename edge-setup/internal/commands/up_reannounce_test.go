package commands

import "testing"

func TestHermesReannounceOnlyWhenUpChangedTheInstalledHermes(t *testing.T) {
	cases := []struct {
		name          string
		before, after string
		want          bool
	}{
		{"upgraded", "0.22.2", "0.23.0", true},
		{"first install", "", "0.23.0", true},
		{"rolled back", "0.23.0", "0.22.2", true},
		{"same version re-run", "0.23.0", "0.23.0", false},
		{"stamp unreadable after the run", "0.22.2", "", false},
		{"nothing either side", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := hermesReannounceNeeded(c.before, c.after); got != c.want {
				t.Fatalf("hermesReannounceNeeded(%q, %q) = %v, want %v", c.before, c.after, got, c.want)
			}
		})
	}
}
