#!/usr/bin/env bun
// Offline contract: no default of the edge-setup release path points at the
// retired GitHub releases repository again.
//
// Why: that repository is private now (docs/cloud/ADR_RELEASE_HOSTING.md), so
// an anonymous download from it can only fail, and it is no longer the public
// origin a host trusts. The public origin is
// https://releases.openedbot.app/edge-setup, the console feed reads
// https://releases.openedbot.app/edge-setup/edge-setup.json. The URL used to be
// copied into each file below; one of them drifting back would silently
// restore a dead install or upgrade path.

const ORIGIN = "https://releases.openedbot.app/edge-setup";
const ANCHOR = "https://releases.openedbot.app/edge-setup/edge-setup.json";

// Every file of this repository that carries a default of the release path,
// and the constant it must hold. The host side (selfupdate.go, its Makefile,
// nfpm.yaml, its workflows) is held by the same contract in edge-setup/
// (internal/selfupdate/origin_contract_test.go); the install bootstrap by the
// tests of docs/.
const FILES: { path: string; mustContain: string[] }[] = [
  // Since deba06f the console installs through the signed bootstrap
  // (docs.openedbot.app/install), which pins the release itself: the console
  // carries no release origin any more, only the forbidden patterns apply.
  { path: "apps/console/src/screens/settings/installation/cloud/cloud-enrollment.tsx", mustContain: [] },
  { path: "platform/config/src/api-config.ts", mustContain: [ANCHOR] },
  { path: "platform/config/src/env-schema/shared.ts", mustContain: [ANCHOR] },
  { path: "modules/runtime-link/src/application/connector-release-feed.ts", mustContain: [] },
];

// The retired repository under its former public owner, and any GitHub
// release download or API URL of a repository with that name (the private
// mirror included: it is never a default). The owner match is case-sensitive:
// selfupdate.go names it in lower case to refuse it.
const FORBIDDEN: RegExp[] = [
  /MakFly\/edge-setup-releases/,
  /github\.com\/[\w.-]+\/edge-setup-releases\/releases/i,
  /api\.github\.com\/repos\/[\w.-]+\/edge-setup-releases/i,
];

function forbiddenLines(text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => FORBIDDEN.some((pattern) => pattern.test(line)))
    .map(({ line, number }) => `${number}: ${line.trim()}`);
}

const failures: string[] = [];

// The matcher itself: a reintroduced default must be caught, the new origin
// and the private mirror's bare name must not.
for (const bad of [
  'REPO="MakFly/edge-setup-releases"',
  'const DefaultBaseURL = "https://github.com/MakFly/edge-setup-releases/releases/latest/download"',
  'BASE="https://github.com/OpenedBot/edge-setup-releases/releases/latest/download"',
  'export const DEFAULT_CONNECTOR_RELEASES_URL = "https://api.github.com/repos/OpenedBot/edge-setup-releases/releases/latest";',
]) {
  if (forbiddenLines(bad).length !== 1) failures.push(`le contrat ne détecte pas : ${bad}`);
}
for (const good of [ORIGIN, ANCHOR, "RELEASES_REPO ?= OpenedBot/edge-setup-releases", 'strings.Contains(path, "/makfly/edge-setup-releases")']) {
  if (forbiddenLines(good).length !== 0) failures.push(`le contrat refuse à tort : ${good}`);
}

for (const { path, mustContain } of FILES) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    failures.push(`${path} : fichier absent ; mettre à jour la liste du contrat`);
    continue;
  }
  const text = await file.text();
  for (const hit of forbiddenLines(text)) failures.push(`${path}:${hit} : ancien dépôt GitHub de releases`);
  for (const expected of mustContain) {
    if (!text.includes(expected)) failures.push(`${path} : ne porte plus ${expected}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`edge-setup-release-url-contract: ${failure}`);
  console.error(`edge-setup-release-url-contract: ${failures.length} erreur(s)`);
  process.exit(1);
}
console.log(`edge-setup-release-url-contract: OK (${FILES.length} fichier(s))`);
