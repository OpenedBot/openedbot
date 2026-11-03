import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The bootstrap served at /install is the static file public/install;
// public/_headers gives it its response headers (Cloudflare static assets).
const INSTALL_PATH = join(import.meta.dir, '..', 'public', 'install');
const HEADERS_PATH = join(import.meta.dir, '..', 'public', '_headers');
const INSTALL_SCRIPT = readFileSync(INSTALL_PATH, 'utf8');

type RunOptions = {
  /** What the fake `uname -s` answers: the installer supports only Linux. */
  os?: string;
  machine?: string;
  arch?: string;
  uid?: string;
  badDigest?: boolean;
  duplicateManifest?: boolean;
  candidate?: string;
  hashTool?: 'sha256sum' | 'shasum';
  hermeticPath?: boolean;
  missingManifest?: boolean;
  version?: string;
  /** Pass the version through the pre-rename HERMES_SETUP_VERSION only. */
  legacyVersionEnv?: boolean;
  /** What the fake cosign answers about the signature of SHA256SUMS. */
  signature?: 'valid' | 'invalid';
  /** The release serves no SHA256SUMS.sigstore.json. */
  missingBundle?: boolean;
  /** Use the pinned cosign download instead of EDGE_SETUP_COSIGN. */
  pinnedCosign?: boolean;
  /** What the origin's LATEST pointer holds. */
  latest?: string;
  /** Arguments after `sh -s --`. */
  args?: string[];
};

const workDirs: string[] = [];
const defaultCandidate = '#!/bin/sh\necho "edge-setup v-test"\n';

afterEach(async () => {
  await Promise.all(workDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function systemTool(name: string): string {
  const result = spawnSync('/bin/sh', {
    input: 'command -v ' + name + '\n',
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error('test host is missing ' + name);
  }
  return result.stdout.trim();
}

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function addHermeticSystemTools(bin: string): Promise<void> {
  for (const name of ['awk', 'chmod', 'dirname', 'install', 'ln', 'mkdir', 'mktemp', 'rm']) {
    await symlink(systemTool(name), join(bin, name));
  }
}

async function runInstaller({
  os = 'Linux',
  machine = 'x86_64',
  arch = 'amd64',
  uid = '1000',
  badDigest = false,
  duplicateManifest = false,
  candidate = defaultCandidate,
  hashTool = 'sha256sum',
  hermeticPath = hashTool === 'shasum',
  missingManifest = false,
  version = '',
  legacyVersionEnv = false,
  signature = 'valid',
  missingBundle = false,
  pinnedCosign = false,
  latest = 'v0.0.7\n',
  args = [],
}: RunOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'edge-setup-install-test-'));
  workDirs.push(dir);

  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const destination = join(dir, 'edge-setup');
  const aliasPaths = [join(dir, 'hermes-setup')];
  const asset = 'edge-setup_linux_' + arch;
  const digest = createHash('sha256').update(candidate).digest('hex');
  const manifestDigest = badDigest ? '0'.repeat(64) : digest;
  const manifestEntry = manifestDigest + '  ' + asset + '\n';
  const sums = duplicateManifest ? manifestEntry + manifestEntry : manifestEntry;
  const sudoLog = join(dir, 'sudo.log');
  const hashLog = join(dir, 'hash.log');
  const curlLog = join(dir, 'curl.log');
  const cosignLog = join(dir, 'cosign.log');
  const cosign = join(dir, 'trusted-cosign');

  await executable(join(bin, 'uname'), '#!/bin/sh\n' +
    'case "$1" in\n' +
    '  -s) printf "%s\\n" ' + shellQuote(os) + ' ;;\n' +
    '  -m) printf "%s\\n" ' + shellQuote(machine) + ' ;;\n' +
    '  *) echo "unexpected uname argument" >&2; exit 2 ;;\n' +
    'esac\n');
  await executable(join(bin, 'id'), '#!/bin/sh\n' +
    'case "$1" in\n' +
    '  -u) printf "%s\\n" ' + shellQuote(uid) + ' ;;\n' +
    '  *) exit 2 ;;\n' +
    'esac\n');
  await executable(join(bin, 'sudo'), '#!/bin/sh\n' +
    'printf "sudo\\n" >> "$HERMES_TEST_SUDO_LOG"\n' +
    'exec "$@"\n');

  await executable(join(bin, 'curl'), '#!/bin/sh\n' +
    'out=\n' +
    'url=\n' +
    'while [ "$#" -gt 0 ]; do\n' +
    '  case "$1" in\n' +
    '    -o) out="$2"; shift 2 ;;\n' +
    '    *) url="$1"; shift ;;\n' +
    '  esac\n' +
    'done\n' +
    'printf "%s\\n" "$url" >> "$HERMES_TEST_CURL_LOG"\n' +
    'case "$url" in\n' +
    '  */SHA256SUMS) if [ -n "$HERMES_TEST_MISSING_MANIFEST" ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi; printf "%s" ' + shellQuote(sums) + ' > "$out" ;;\n' +
    '  */SHA256SUMS.sigstore.json) if [ -n "$HERMES_TEST_MISSING_BUNDLE" ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi; printf "{}" > "$out" ;;\n' +
    '  */LATEST) printf "%s" ' + shellQuote(latest) + ' > "$out" ;;\n' +
    '  */cosign-linux-*) printf "#!/bin/sh\\nexit 0\\n" > "$out" ;;\n' +
    '  */' + asset + ') printf "%s" ' + shellQuote(candidate) + ' > "$out" ;;\n' +
    '  *) echo "unexpected URL: $url" >&2; exit 9 ;;\n' +
    'esac\n');

  if (hashTool === 'shasum') {
    const sha256sum = shellQuote(systemTool('sha256sum'));
    await executable(join(bin, 'shasum'), '#!/bin/sh\n' +
      '[ "$1" = -a ] && [ "$2" = 256 ] && [ "$#" -eq 3 ] || exit 2\n' +
      'printf "shasum\\n" >> "$HERMES_TEST_HASH_LOG"\n' +
      'exec ' + sha256sum + ' "$3"\n');
  }

  // The trusted cosign of EDGE_SETUP_COSIGN: logs its arguments and answers
  // what the test says about the signature.
  await executable(cosign, '#!/bin/sh\n' +
    'printf "%s\\n" "$*" >> "$HERMES_TEST_COSIGN_LOG"\n' +
    'printf "TUF_ROOT=%s\\n" "$TUF_ROOT" >> "$HERMES_TEST_COSIGN_LOG"\n' +
    'if [ "$HERMES_TEST_SIGNATURE" = valid ]; then echo "Verified OK" >&2; exit 0; fi\n' +
    'echo "Error: none of the expected identities matched what was in the certificate" >&2\n' +
    'exit 1\n');

  if (hermeticPath) await addHermeticSystemTools(bin);

  const result = spawnSync('/bin/sh', ['-s', '--', ...args], {
    input: INSTALL_SCRIPT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: hermeticPath ? bin : bin + ':/usr/bin:/bin',
      TMPDIR: dir,
      EDGE_SETUP_DEST: destination,
      HERMES_SETUP_DEST: '',
      EDGE_SETUP_VERSION: legacyVersionEnv ? '' : version,
      HERMES_SETUP_VERSION: legacyVersionEnv ? version : '',
      HERMES_TEST_SUDO_LOG: sudoLog,
      HERMES_TEST_CURL_LOG: curlLog,
      HERMES_TEST_MISSING_MANIFEST: missingManifest ? '1' : '',
      HERMES_TEST_HASH_LOG: hashLog,
      HERMES_TEST_MISSING_BUNDLE: missingBundle ? '1' : '',
      HERMES_TEST_COSIGN_LOG: cosignLog,
      HERMES_TEST_SIGNATURE: signature,
      EDGE_SETUP_COSIGN: pinnedCosign ? '' : cosign,
    },
  });

  return { result, dir, bin, destination, aliasPaths, candidate, asset, sudoLog, hashLog, curlLog, cosignLog, hermeticPath };
}

// Cloudflare static assets `_headers`: a URL pattern line, then indented
// `Name: value` lines that apply to it.
function headersFor(path: string): Map<string, string> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of readFileSync(HEADERS_PATH, 'utf8').split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    if (!current) throw new Error('_headers: header line before any URL pattern: ' + line);
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error('_headers: malformed header line: ' + line);
    current.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const found = rules.get(path);
  if (!found) throw new Error('_headers has no rule for ' + path);
  return found;
}

describe('GET /install', () => {
  test('public/_headers serves the POSIX bootstrap with safe response headers', () => {
    const headers = headersFor('/install');
    expect(headers.get('content-type')).toBe('text/x-shellscript; charset=utf-8');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('cache-control')).toBe('public, max-age=300');
  });

  test('public/install is a POSIX shell script that runs nothing before its last line', () => {
    expect(INSTALL_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true);
    expect(INSTALL_SCRIPT).toContain('\nset -eu\n');
    expect(INSTALL_SCRIPT).toContain('if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi');
    expect(INSTALL_SCRIPT.endsWith('\nmain "$@"\n')).toBe(true);
    // Above main, only assignments, functions and the shell options: a
    // download cut anywhere before the last line defines but runs nothing.
    const body = INSTALL_SCRIPT.slice(0, INSTALL_SCRIPT.lastIndexOf('\nmain "$@"\n'));
    let depth = 0;
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (depth === 0 && trimmed && !trimmed.startsWith('#')) {
        expect(trimmed, line).toMatch(/^(#!\/bin\/sh|set -eu|if \(set -o pipefail\) 2>\/dev\/null; then set -o pipefail; fi|[A-Z0-9_]+="[^"$`]*"|[a-z_]+\(\) \{)$/);
      }
      if (/^[a-z_]+\(\) \{$/.test(trimmed)) depth++;
      if (line === '}') depth--;
    }
    expect(depth).toBe(0);
  });

  test('a truncated download runs nothing', () => {
    const cut = INSTALL_SCRIPT.slice(0, INSTALL_SCRIPT.lastIndexOf('main "$@"'));
    const result = spawnSync('/bin/sh', { input: cut, encoding: 'utf8', env: { PATH: '/nonexistent' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toBe('');
  });

  test('never downloads over anything but HTTPS 1.2+, and pins its release', () => {
    expect(INSTALL_SCRIPT).toContain("curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL");
    // fetch() is the only place that calls curl.
    expect(INSTALL_SCRIPT.split('\n').filter((line) => /^\s*curl /.test(line)).length).toBe(1);
    expect(INSTALL_SCRIPT).toMatch(/\nPINNED_VERSION="v\d+\.\d+\.\d+"\n/);
  });
});

async function fetchedURLs(run: { curlLog: string }): Promise<string[]> {
  if (!(await pathExists(run.curlLog))) return [];
  return (await readFile(run.curlLog, 'utf8')).split('\n').filter(Boolean);
}

describe('release origin', () => {
  test('never names the retired GitHub releases repository', () => {
    expect(INSTALL_SCRIPT).not.toContain('MakFly/edge-setup-releases');
    expect(INSTALL_SCRIPT).not.toContain('edge-setup-releases');
  });

  test('downloads from the release origin and the pinned cosign release only', () => {
    expect(INSTALL_SCRIPT).toContain('RELEASES="https://releases.openedbot.app/edge-setup"');
    const code = INSTALL_SCRIPT.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    const origins = new Set(code.match(/https?:\/\/[^\s"'`)]+/g) ?? []);
    expect([...origins].sort()).toEqual([
      'https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/',
      'https://github.com/sigstore/cosign/releases/download',
      'https://releases.openedbot.app/edge-setup',
      'https://token.actions.githubusercontent.com',
    ]);
  });

  test('installs the pinned release by default, never an implicit latest', async () => {
    const pinned = INSTALL_SCRIPT.match(/\nPINNED_VERSION="(v[^"]+)"\n/)![1];
    const run = await runInstaller({ uid: '0' });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(await fetchedURLs(run)).toEqual([
      'https://releases.openedbot.app/edge-setup/' + pinned + '/SHA256SUMS',
      'https://releases.openedbot.app/edge-setup/' + pinned + '/SHA256SUMS.sigstore.json',
      'https://releases.openedbot.app/edge-setup/' + pinned + '/edge-setup_linux_amd64',
    ]);
  });

  test('reads another version under its own path, from the environment or --version', async () => {
    for (const options of [{ version: 'v0.0.1' }, { args: ['--version', 'v0.0.1'] }, { args: ['--version=v0.0.1'] }]) {
      const run = await runInstaller({ uid: '0', ...options });
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(await fetchedURLs(run)).toEqual([
        'https://releases.openedbot.app/edge-setup/v0.0.1/SHA256SUMS',
        'https://releases.openedbot.app/edge-setup/v0.0.1/SHA256SUMS.sigstore.json',
        'https://releases.openedbot.app/edge-setup/v0.0.1/edge-setup_linux_amd64',
      ]);
    }
  });

  test('resolves latest only when asked, then reads that version path', async () => {
    const run = await runInstaller({ uid: '0', args: ['--version', 'latest'] });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(await fetchedURLs(run)).toEqual([
      'https://releases.openedbot.app/edge-setup/LATEST',
      'https://releases.openedbot.app/edge-setup/v0.0.7/SHA256SUMS',
      'https://releases.openedbot.app/edge-setup/v0.0.7/SHA256SUMS.sigstore.json',
      'https://releases.openedbot.app/edge-setup/v0.0.7/edge-setup_linux_amd64',
    ]);
  });

  test('refuses a version or a LATEST pointer that is not vX.Y.Z', async () => {
    for (const options of [{ version: 'v0.0.1/../x' }, { version: 'v1.2' }, { version: 'v1.2.3-rc1' }, { args: ['--version', 'latest'], latest: '../v1.2.3\n' }]) {
      const run = await runInstaller({ uid: '0', ...options });
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain('invalid version');
      expect(await pathExists(run.destination)).toBe(false);
    }
  });

  test('still accepts the pre-rename HERMES_SETUP_VERSION as a fallback', async () => {
    const run = await runInstaller({ uid: '0', version: 'v0.0.1', legacyVersionEnv: true });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect((await fetchedURLs(run))[0]).toBe('https://releases.openedbot.app/edge-setup/v0.0.1/SHA256SUMS');
  });

  test('fails closed with exit 1 when the origin serves no release, without any fallback', async () => {
    const run = await runInstaller({ uid: '0', version: 'v0.0.1', missingManifest: true });
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain('no release v0.0.1 could be fetched from https://releases.openedbot.app/edge-setup');
    expect(await fetchedURLs(run)).toEqual(['https://releases.openedbot.app/edge-setup/v0.0.1/SHA256SUMS']);
    expect(await pathExists(run.destination)).toBe(false);
  });
});

describe('signature', () => {
  test('a valid signature is checked for the release workflow of that very tag', async () => {
    const run = await runInstaller({ uid: '0', version: 'v0.0.1' });
    expect(run.result.status, run.result.stderr).toBe(0);
    const log = await readFile(run.cosignLog, 'utf8');
    expect(log).toContain('verify-blob --bundle ' + run.dir);
    expect(log).toContain('--certificate-identity https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/v0.0.1');
    expect(log).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com');
    // cosign's trust cache stays in the work directory, removed on exit.
    expect(log).toMatch(/TUF_ROOT=.*\/edge-setup\.[A-Za-z0-9]+\/tuf/);
    expect(run.result.stdout).toContain('signature verified');
  });

  test('an invalid signature installs nothing and never downloads the binary', async () => {
    const run = await runInstaller({ uid: '1000', signature: 'invalid' });
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain('the signature of SHA256SUMS does not verify');
    expect(run.result.stderr).toContain('none of the expected identities matched');
    expect((await fetchedURLs(run)).some((url) => url.endsWith('/edge-setup_linux_amd64'))).toBe(false);
    expect(await pathExists(run.destination)).toBe(false);
    expect(await pathExists(run.sudoLog)).toBe(false);
  });

  test('a release without a signature installs nothing', async () => {
    const run = await runInstaller({ uid: '1000', missingBundle: true });
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain('carries no signature (SHA256SUMS.sigstore.json)');
    expect(await pathExists(run.cosignLog)).toBe(false);
    expect(await pathExists(run.destination)).toBe(false);
  });

  test('the pinned cosign is refused when its SHA-256 differs, before it runs', async () => {
    const run = await runInstaller({ uid: '0', pinnedCosign: true });
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain('SHA-256 mismatch for cosign v3.1.4');
    expect(await fetchedURLs(run)).toContain('https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-linux-amd64');
    expect(await pathExists(run.destination)).toBe(false);
  });

  test('a cosign the operator trusts (EDGE_SETUP_COSIGN) replaces the pinned download', async () => {
    const run = await runInstaller({ uid: '0' });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stdout).toContain('signature check with');
    expect((await fetchedURLs(run)).some((url) => url.includes('sigstore/cosign'))).toBe(false);
  });
});

describe('dry run', () => {
  test('verifies everything, prints the plan and changes nothing', async () => {
    const run = await runInstaller({ uid: '1000', args: ['--dry-run'] });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stdout).toContain('dry run: release ');
    expect(run.result.stdout).toContain('signature verified');
    expect(run.result.stdout).toContain('SHA-256 verified: edge-setup_linux_amd64');
    expect(run.result.stdout).toContain('dry run: would run: sudo install -m 0755 edge-setup_linux_amd64 ' + run.destination);
    expect(await pathExists(run.destination)).toBe(false);
    expect(await pathExists(run.sudoLog)).toBe(false);
    // The work directory is gone: only the test's own files remain in TMPDIR.
    const leftovers = spawnSync('/bin/ls', [run.dir], { encoding: 'utf8' }).stdout.split('\n').filter((name) => name.startsWith('edge-setup.'));
    expect(leftovers).toEqual([]);
  });

  test('refuses an unknown argument', async () => {
    const run = await runInstaller({ uid: '0', args: ['--yes'] });
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain('unknown argument: --yes');
    expect(await fetchedURLs(run)).toEqual([]);
  });
});

describe('release installer', () => {
  for (const sample of [
    { machine: 'x86_64', arch: 'amd64', uid: '1000', usesSudo: true },
    { machine: 'aarch64', arch: 'arm64', uid: '0', usesSudo: false },
  ]) {
    test('installs the ' + sample.arch + ' binary without a legacy alias', async () => {
      const run = await runInstaller(sample);
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.asset).toBe('edge-setup_linux_' + sample.arch);
      expect(await readFile(run.destination, 'utf8')).toBe(run.candidate);
      expect((await lstat(run.destination)).mode & 0o777).toBe(0o755);
      expect(await pathExists(run.aliasPaths[0])).toBe(false);
      expect(await pathExists(run.sudoLog)).toBe(sample.usesSudo);
      expect(run.result.stdout).toContain('next: sudo edge-setup detect');
    });
  }

  test('uses shasum when sha256sum is absent from the hermetic PATH', async () => {
    const run = await runInstaller({ uid: '0', hashTool: 'shasum', hermeticPath: true });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.hermeticPath).toBe(true);
    expect(await readFile(run.hashLog, 'utf8')).toContain('shasum');
    expect(await pathExists(join(run.bin, 'sha256sum'))).toBe(false);
    expect(await readFile(run.destination, 'utf8')).toBe(run.candidate);
  });

  for (const os of ['Darwin', 'FreeBSD']) {
    test('refuses ' + os + ' before downloading anything', async () => {
      const run = await runInstaller({ os, uid: '0' });
      expect(run.result.status).toBe(1);
      expect(run.result.stderr).toContain('unsupported operating system: ' + os);
      expect(run.result.stderr).toContain('Debian 12 or later, or Ubuntu 24.04 or later');
      expect(await fetchedURLs(run)).toEqual([]);
      expect(await pathExists(run.destination)).toBe(false);
      expect(await pathExists(run.sudoLog)).toBe(false);
    });
  }

  test('refuses an unsupported architecture before downloading anything', async () => {
    const run = await runInstaller({ machine: 'riscv64', uid: '0' });
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain('unsupported architecture: riscv64');
    expect(await fetchedURLs(run)).toEqual([]);
    expect(await pathExists(run.destination)).toBe(false);
  });

  test('installs nothing on a digest mismatch or duplicate manifest entries', async () => {
    const cases: { name: string; options: RunOptions; expected: string }[] = [
      { name: 'digest mismatch', options: { badDigest: true }, expected: 'SHA-256 mismatch' },
      { name: 'duplicate manifest entries', options: { duplicateManifest: true }, expected: 'SHA256SUMS has no valid digest' },
    ];
    for (const sample of cases) {
      const run = await runInstaller({ uid: '1000', ...sample.options });
      expect(run.result.status, sample.name).toBe(1);
      expect(run.result.stderr, sample.name).toContain(sample.expected);
      expect(await pathExists(run.destination), sample.name).toBe(false);
      for (const alias of run.aliasPaths) expect(await pathExists(alias), sample.name).toBe(false);
      expect(await pathExists(run.sudoLog), sample.name).toBe(false);
    }
  });
});
