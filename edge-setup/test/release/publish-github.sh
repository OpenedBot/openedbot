#!/usr/bin/env bash
# Fake GitHub API; no credentials, network or remote mutations.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/signed"
printf 'binary\n' > "$tmp/signed/edge-setup_linux_arm64"
printf 'manifest\n' > "$tmp/signed/SHA256SUMS"
printf 'signature\n' > "$tmp/signed/SHA256SUMS.sigstore.json"
printf 'public release notes\n' > "$tmp/notes"
cat > "$tmp/bin/gh" <<'FAKE'
#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ['FAKE_ROOT'])
mode = os.environ['FAKE_MODE']
with (root / 'calls').open('a') as log:
    log.write(' '.join(args) + '\n')
files = sorted(p.name for p in (root / 'signed').iterdir())
if args[:2] == ['release', 'create']:
    if mode == 'create-fails':
        sys.exit(1)
    (root / 'created').touch()
    sys.exit(0)
endpoint = args[-1]
if '/releases/tags/' in endpoint:
    if mode in ['403', '500', 'transport']:
        if mode != 'transport':
            print(json.dumps({'status': mode}))
        sys.exit(1)
    if mode in ['absent', 'create-fails'] and not (root / 'created').exists():
        print(json.dumps({'status': '404'}))
        sys.exit(1)
    print(json.dumps({'id': 42, 'tag_name': 'edge-setup/v1.5.6', 'draft': mode == 'draft', 'prerelease': mode == 'prerelease'}))
elif endpoint.endswith('/42/assets'):
    assets = [{'id': i + 100, 'name': name, 'state': 'uploaded'} for i, name in enumerate(files)]
    if mode == 'missing':
        assets.pop()
    if mode == 'extra':
        assets.append({'id': 999, 'name': 'unexpected', 'state': 'uploaded'})
    if mode == 'duplicate':
        assets.append(assets[0])
    if mode == 'unfinished':
        assets[0]['state'] = 'new'
    # Multiple pages exercise the explicit flattening of all API pages.
    print(json.dumps([assets[:1], assets[1:]]))
elif '/releases/assets/' in endpoint:
    if mode == 'download-fails':
        sys.exit(1)
    name = files[int(endpoint.rsplit('/', 1)[1]) - 100]
    sys.stdout.buffer.write(b'changed' if mode == 'changed' else (root / 'signed' / name).read_bytes())
else:
    sys.exit('unexpected gh call: ' + repr(args))
FAKE
chmod +x "$tmp/bin/gh"
run() {
	PATH="$tmp/bin:$PATH" FAKE_ROOT="$tmp" FAKE_MODE="$1" GH_REPO=OpenedBot/openedbot \
		bash "$root/scripts/publish-github.sh" v1.5.6 "$tmp/signed" "$tmp/notes" > "$tmp/out" 2>&1
}
fail() { cat "$tmp/out"; echo "publish-github test: $*" >&2; exit 1; }
for mode in existing absent; do
	: > "$tmp/calls"
	run "$mode" || fail "$mode failed"
	if [[ "$mode" == absent ]]; then
		grep -q '^release create .*--verify-tag --latest=false' "$tmp/calls" || fail "no guarded creation"
	else
		! grep -q '^release create' "$tmp/calls" || fail "existing release mutated"
	fi
	[[ "$(grep -c 'Accept: application/octet-stream' "$tmp/calls")" == 3 ]] || fail "not all files compared"
done
rm "$tmp/created"
for mode in missing extra duplicate changed unfinished draft prerelease 403 500 transport download-fails create-fails; do
	: > "$tmp/calls"
	if run "$mode"; then fail "$mode accepted"; fi
	if [[ "$mode" != create-fails ]]; then
		! grep -q '^release create' "$tmp/calls" || fail "$mode triggered a mutation"
	fi
done
echo 'publish-github: creation, identical retry and 12 failure cases passed'
