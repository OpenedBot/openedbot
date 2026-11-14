package pins

import "testing"

func TestChromiumPinsMatchHermes023Lock(t *testing.T) {
	for arch, want := range map[string]ChromiumArchive{
		"amd64": {"linux-x64", "https://cdn.playwright.dev/builds/cft/145.0.7632.6/linux64/chrome-linux64.zip", "b5e3195041af345a668d110f5daf5581961fa3608626ea588c97dd0fe81c4e38"},
		"arm64": {"linux-arm64", "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1208/chromium-linux-arm64.zip", "70b4620521b1ada360475e1059dfe9d549a6461a79b9342f85b7d47e44123077"},
	} {
		got, err := ChromiumFor("linux", arch)
		if err != nil || got != want {
			t.Fatalf("%s: %#v %v", arch, got, err)
		}
	}
	if ChromiumVersion != "1208+145.0.7632.6" {
		t.Fatal("Chromium pin drift")
	}
	for _, target := range [][2]string{{"darwin", "arm64"}, {"windows", "amd64"}, {"linux", "386"}} {
		if _, err := ChromiumFor(target[0], target[1]); err == nil {
			t.Fatalf("unsupported target accepted: %v", target)
		}
	}
}
