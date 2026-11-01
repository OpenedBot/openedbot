package pins

// MacArches lists the pinned artifacts for supported macOS connector hosts.
// UV binary digests are verified after extracting the checksum-pinned release
// archives. Node archive digests come from the official SHASUMS256.txt.
var MacArches = map[string]Arch{
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

// MacNodeArchiveURL is the download location of the Node release archive for macOS.
func MacNodeArchiveURL(a Arch) string {
	return "https://nodejs.org/dist/" + NodeVersion + "/node-" + NodeVersion + "-darwin-" + a.NodeTarget + ".tar.gz"
}
