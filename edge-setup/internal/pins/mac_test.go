package pins

import "testing"

func TestMacArchesPinOfficialArtifacts(t *testing.T) {
	if UVVersion != "0.12.7" || NodeVersion != "v22.23.2" || PythonVersion != "3.14.7" {
		t.Fatalf("shared runtime pins changed: uv=%s node=%s python=%s", UVVersion, NodeVersion, PythonVersion)
	}

	want := map[string]Arch{
		"amd64": {
			Go:                "amd64",
			UVTarget:          "x86_64-apple-darwin",
			UVArchiveSHA256:   "06b8ae1da8c2661c5434507a66f8c2b0b835933bf955b5958a9ac357a37d1959",
			UVBinarySHA256:    "5563d51cb726dc2f17764b299ba2a665348460e61e831810b56140ebbd75e3c9",
			UVXBinarySHA256:   "d2a9c545355860ee0545025df7c7fab78d827381543f07fef03b2791ea1b9b69",
			NodeTarget:        "x64",
			NodeArchiveSHA256: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
		},
		"arm64": {
			Go:                "arm64",
			UVTarget:          "aarch64-apple-darwin",
			UVArchiveSHA256:   "127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3",
			UVBinarySHA256:    "55936a60bff5de7ac04facb72f9e6fd0ffd9661063480224c3ab321c3f10caff",
			UVXBinarySHA256:   "a2ab191eb82f85d4dfe071f3eba5094556598b1204a9fe5b41a7d7c0b7363a2e",
			NodeTarget:        "arm64",
			NodeArchiveSHA256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
		},
	}

	if len(MacArches) != len(want) {
		t.Fatalf("macOS architectures = %v, want only %v", MacArches, want)
	}
	for goarch, expected := range want {
		got, ok := MacArches[goarch]
		if !ok || got != expected {
			t.Errorf("MacArches[%q] = %#v, present=%v, want %#v", goarch, got, ok, expected)
		}
		if gotURL, wantURL := UVArchiveURL(expected), "https://github.com/astral-sh/uv/releases/download/0.12.7/uv-"+expected.UVTarget+".tar.gz"; gotURL != wantURL {
			t.Errorf("UVArchiveURL(%q) = %q, want %q", goarch, gotURL, wantURL)
		}
		if gotURL, wantURL := MacNodeArchiveURL(expected), "https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-"+expected.NodeTarget+".tar.gz"; gotURL != wantURL {
			t.Errorf("MacNodeArchiveURL(%q) = %q, want %q", goarch, gotURL, wantURL)
		}
	}
}
