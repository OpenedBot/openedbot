package selfupdate

import (
	"context"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAssetNameForSupportedPlatforms(t *testing.T) {
	tests := []struct {
		goos string
		arch string
		want string
	}{
		{goos: "linux", arch: "amd64", want: "edge-setup_linux_amd64"},
		{goos: "linux", arch: "arm64", want: "edge-setup_linux_arm64"},
		{goos: "darwin", arch: "amd64", want: "edge-setup_darwin_amd64"},
		{goos: "darwin", arch: "arm64", want: "edge-setup_darwin_arm64"},
	}
	for _, tt := range tests {
		t.Run(tt.goos+"/"+tt.arch, func(t *testing.T) {
			got, err := AssetNameForOS(tt.goos, tt.arch)
			if err != nil || got != tt.want {
				t.Fatalf("AssetNameForOS(%q, %q) = %q, %v; want %q", tt.goos, tt.arch, got, err, tt.want)
			}
		})
	}
}

func TestAssetLookupForOSUsesOnlyMatchingPlatformAndPrefersCanonical(t *testing.T) {
	sums := map[string]string{
		"edge-setup_linux_amd64":    "linux-canonical",
		"hermes-setup_linux_amd64":  "linux-legacy",
		"edge-setup_darwin_arm64":   "darwin-canonical",
		"hermes-setup_darwin_arm64": "darwin-legacy",
	}
	name, want, err := AssetLookupForOS(sums, "darwin", "arm64")
	if err != nil || name != "edge-setup_darwin_arm64" || want != "darwin-canonical" {
		t.Fatalf("canonical lookup = %q, %q, %v", name, want, err)
	}

	delete(sums, "edge-setup_darwin_arm64")
	name, want, err = AssetLookupForOS(sums, "darwin", "arm64")
	if err != nil || name != "hermes-setup_darwin_arm64" || want != "darwin-legacy" {
		t.Fatalf("same-platform legacy lookup = %q, %q, %v", name, want, err)
	}

	name, want, err = AssetLookupForOS(map[string]string{
		"edge-setup_linux_arm64":   "linux-canonical",
		"hermes-setup_linux_arm64": "linux-legacy",
	}, "darwin", "arm64")
	if err != nil || name != "hermes-setup_darwin_arm64" || want != "" {
		t.Fatalf("Darwin lookup crossed to Linux asset: %q, %q, %v", name, want, err)
	}

	legacyName, legacySum := AssetLookup(map[string]string{
		"edge-setup_linux_amd64":   "linux-canonical",
		"hermes-setup_linux_amd64": "linux-legacy",
	}, "amd64")
	if legacyName != "edge-setup_linux_amd64" || legacySum != "linux-canonical" {
		t.Fatalf("legacy Linux API changed: %q, %q", legacyName, legacySum)
	}
}

func TestDefaultReleaseForOSMatrixAndNativeDefault(t *testing.T) {
	for _, goos := range []string{"linux", "darwin"} {
		for _, arch := range []string{"amd64", "arm64"} {
			t.Run(goos+"/"+arch, func(t *testing.T) {
				release, err := DefaultReleaseForOS(goos, arch, "")
				if err != nil {
					t.Fatal("supported release platform was rejected")
				}
				if release.OS != goos || release.Arch != arch || release.BaseURL != DefaultBaseURL || release.HTTP == nil {
					t.Fatalf("unexpected release configuration: %#v", release)
				}
			})
		}
	}

	release, err := DefaultRelease(runtime.GOARCH, "")
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		if runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64" {
			if err != nil || release.OS != runtime.GOOS || release.Arch != runtime.GOARCH {
				t.Fatalf("DefaultRelease did not use the current platform: %#v, %v", release, err)
			}
			return
		}
	}
	if err == nil {
		t.Fatalf("DefaultRelease accepted unsupported native platform %s/%s", runtime.GOOS, runtime.GOARCH)
	}
}

func TestUnsupportedPlatformsRefuseBeforeAnyRequest(t *testing.T) {
	var hits int32
	srv := releaseServer(t, "", "", nil, &hits)
	defer srv.Close()

	tests := []struct {
		goos string
		arch string
	}{
		{goos: "freebsd", arch: "amd64"},
		{goos: "linux", arch: "386"},
		{goos: "darwin", arch: "armv7"},
		{goos: "../linux", arch: "amd64"},
		{goos: "darwin", arch: "../../arm64"},
	}
	for _, tt := range tests {
		t.Run(tt.goos+"/"+tt.arch, func(t *testing.T) {
			if _, err := AssetNameForOS(tt.goos, tt.arch); err == nil {
				t.Fatal("unsupported release platform was accepted")
			}
			if _, _, err := AssetLookupForOS(nil, tt.goos, tt.arch); err == nil {
				t.Fatal("unsupported asset lookup platform was accepted")
			}
			if _, err := DefaultReleaseForOS(tt.goos, tt.arch, srv.URL); err == nil {
				t.Fatal("unsupported release platform produced a default release")
			}
			release := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, OS: tt.goos, Arch: tt.arch}
			if _, _, err := release.Download(context.Background()); err == nil {
				t.Fatal("unsupported release platform was downloaded")
			}
			if got := atomic.LoadInt32(&hits); got != 0 {
				t.Fatalf("unsupported release platform made %d HTTP requests", got)
			}
		})
	}
}

func TestDarwinDownloadDoesNotFallBackToLinuxAndRejectsBadDigest(t *testing.T) {
	t.Run("Linux-only manifest does not trigger a Linux binary request", func(t *testing.T) {
		linuxBinary := []byte("linux artifact")
		manifest := Digest(linuxBinary) + "  edge-setup_linux_arm64\n"
		var hits int32
		srv := releaseServer(t, manifest, "edge-setup_linux_arm64", linuxBinary, &hits)
		defer srv.Close()

		release := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, OS: "darwin", Arch: "arm64"}
		if _, _, err := release.Download(context.Background()); err == nil || !strings.Contains(err.Error(), "does not list edge-setup_darwin_arm64") {
			t.Fatalf("Darwin download did not report its missing asset: %v", err)
		}
		if got := atomic.LoadInt32(&hits); got != 2 {
			t.Fatalf("Linux-only manifest caused %d requests, want manifest and signature only", got)
		}
	})

	t.Run("Darwin canonical asset is checksum verified", func(t *testing.T) {
		binary := []byte("Darwin arm64 fixture")
		manifest := strings.Repeat("0", 64) + "  edge-setup_darwin_arm64\n"
		var hits int32
		srv := releaseServer(t, manifest, "edge-setup_darwin_arm64", binary, &hits)
		defer srv.Close()

		release := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, OS: "darwin", Arch: "arm64"}
		if _, _, err := release.Download(context.Background()); err == nil || err.Error() != "downloaded binary does not match SHA256SUMS" {
			t.Fatalf("mismatched Darwin digest was accepted or leaked details: %v", err)
		}
		if got := atomic.LoadInt32(&hits); got != 3 {
			t.Fatalf("checksum verification made %d requests, want manifest, signature and Darwin asset", got)
		}
	})
}

func TestDarwinVerifyUsesSelfHashAndDarwinAssetName(t *testing.T) {
	asset := "edge-setup_darwin_amd64"
	var hits int32
	srv := releaseServer(t, selfManifest(t, asset), asset, nil, &hits)
	defer srv.Close()

	release := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, OS: "darwin", Arch: "amd64"}
	if err := release.Verify(context.Background()); err != nil {
		t.Fatalf("valid self hash under Darwin asset name failed verification: %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("self verification made %d requests, want one manifest and one signature read", got)
	}
}

func TestReleaseLiteralWithoutOSRetainsLinuxCompatibility(t *testing.T) {
	binary := []byte("legacy Linux literal")
	manifest := Digest(binary) + "  edge-setup_linux_amd64\n"
	var hits int32
	srv := releaseServer(t, manifest, "edge-setup_linux_amd64", binary, &hits)
	defer srv.Close()

	release := Release{BaseURL: srv.URL, HTTP: srv.Client(), Version: testVersion, Verifier: acceptSignature{}, Arch: "amd64"}
	got, sum, err := release.Download(context.Background())
	if err != nil || string(got) != string(binary) || sum != Digest(binary) {
		t.Fatalf("blank-OS legacy Release literal failed Linux download: %q, %q, %v", got, sum, err)
	}
	if release.operatingSystem() != "linux" {
		t.Fatalf("blank OS resolved to %q, want linux", release.operatingSystem())
	}
}
