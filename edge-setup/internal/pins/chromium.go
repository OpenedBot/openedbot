package pins

import "fmt"

// Copied from pm/lock.json at HermesInstallerCommit (v0.23.0).
const ChromiumVersion = "1208+145.0.7632.6"

type ChromiumArchive struct{ Target, URL, SHA256 string }

func ChromiumFor(goos, goarch string) (ChromiumArchive, error) {
	if goos != "linux" {
		return ChromiumArchive{}, fmt.Errorf("managed Chromium supports Linux only")
	}
	switch goarch {
	case "amd64":
		return ChromiumArchive{"linux-x64", "https://cdn.playwright.dev/builds/cft/145.0.7632.6/linux64/chrome-linux64.zip", "b5e3195041af345a668d110f5daf5581961fa3608626ea588c97dd0fe81c4e38"}, nil
	case "arm64":
		return ChromiumArchive{"linux-arm64", "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1208/chromium-linux-arm64.zip", "70b4620521b1ada360475e1059dfe9d549a6461a79b9342f85b7d47e44123077"}, nil
	default:
		return ChromiumArchive{}, fmt.Errorf("managed Chromium has no pinned Linux %s build", goarch)
	}
}
