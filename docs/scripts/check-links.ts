// Checks that every internal link of a built site resolves: each root-relative
// href or src in dist/**/*.html must name a built file, and a #fragment on a
// page link must name an id of the target page.
//
// Usage: bun scripts/check-links.ts [dist-dir]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
if (!existsSync(dist)) {
  console.error(`check-links: ${dist} does not exist; run a build first`);
  process.exit(2);
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Built file a root-relative path serves, or null. */
function targetFile(path: string): string | null {
  const clean = safeDecode(path);
  const base = join(dist, clean);
  const candidates = clean.endsWith('/')
    ? [join(base, 'index.html')]
    : [base, join(base, 'index.html'), `${base}.html`];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const idCache = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
  let ids = idCache.get(file);
  if (!ids) {
    const html = readFileSync(file, 'utf8');
    ids = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decodeEntities(m[1] ?? '')));
    idCache.set(file, ids);
  }
  return ids;
}

const problems: string[] = [];
let checked = 0;
let docsLinks = 0;
const pages = htmlFiles(dist);

for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  const from = '/' + relative(dist, file);
  for (const match of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const raw = decodeEntities(match[1] ?? '');
    if (!raw.startsWith('/') || raw.startsWith('//')) continue;
    checked += 1;
    const [pathAndQuery = '', fragment] = raw.split('#', 2);
    const path = pathAndQuery.split('?', 1)[0] ?? '';
    if (path === '/docs' || path.startsWith('/docs/')) docsLinks += 1;
    const target = targetFile(path);
    if (!target) {
      problems.push(`${from}: ${raw} does not resolve to a built file`);
      continue;
    }
    if (fragment && target.endsWith('.html') && !idsOf(target).has(safeDecode(fragment))) {
      problems.push(`${from}: ${raw} names a missing anchor`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`check-links: ${problems.length} broken link(s) in ${pages.length} HTML files`);
  process.exit(1);
}
console.log(
  `check-links: ${checked} internal links (${docsLinks} to /docs) across ${pages.length} HTML files, all resolve`,
);
