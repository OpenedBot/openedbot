import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALL_PAGES,
  PUBLIC_PAGES,
  contentPattern,
  readDocsScope,
  visiblePages,
  visibleSections,
} from '../src/lib/docs-scope';
import { docsSlugOf } from '../src/lib/unlink-hidden-docs';

// English (default, at the root) and French (under /fr/) carry the same pages.
const DOCS_DIR = join(import.meta.dir, '..', 'src', 'content', 'docs', 'docs');
const FR_DOCS_DIR = join(import.meta.dir, '..', 'src', 'content', 'docs', 'fr', 'docs');

function contentPages(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return contentPages(join(dir, entry.name), `${prefix}${entry.name}/`);
    return entry.name.endsWith('.mdx') ? [`${prefix}${entry.name.slice(0, -'.mdx'.length)}`] : [];
  });
}

describe('DOCS_SCOPE', () => {
  test('defaults to public and accepts only public or all', () => {
    expect(readDocsScope(undefined)).toBe('public');
    expect(readDocsScope('')).toBe('public');
    expect(readDocsScope('public')).toBe('public');
    expect(readDocsScope('all')).toBe('all');
    expect(() => readDocsScope('dev')).toThrow('DOCS_SCOPE must be "public" or "all"');
    expect(() => readDocsScope('ALL')).toThrow();
  });

  test('every content page is in the sidebar, and every sidebar entry has a page', () => {
    expect([...contentPages(DOCS_DIR)].sort()).toEqual([...ALL_PAGES].sort());
    expect([...contentPages(FR_DOCS_DIR)].sort()).toEqual([...ALL_PAGES].sort());
    expect(new Set(ALL_PAGES).size).toBe(ALL_PAGES.length);
  });

  test('public pages are the former PUBLIC_PAGE_FILES, in sidebar order', () => {
    for (const page of PUBLIC_PAGES) expect(ALL_PAGES).toContain(page);
    expect(visiblePages('public')).toHaveLength(12);
    expect(visiblePages('all')).toEqual(ALL_PAGES);
    expect(visibleSections('public').map((s) => [s.label, s.labelFr, s.pages])).toEqual([
      ['Using openedbot', 'Utiliser openedbot', ['index', 'compte', 'machine', 'bot', 'conversation', 'reglages']],
      ['Help', 'Aide', ['depannage', 'faq', 'confiance', 'support']],
      ['Reference', 'Référence', ['edge-setup', 'commands']],
    ]);
  });

  test('the developer reference is built only with DOCS_SCOPE=all', () => {
    const reference = ['prerequisites', 'getting-started', 'edge-setup', 'commands', 'operations', 'troubleshooting', 'reset'];
    expect(visiblePages('all')).toHaveLength(20);
    expect(visibleSections('all').map((s) => s.label)).toEqual(['Using openedbot', 'Help', 'Reference', 'In development']);
    expect(visibleSections('all')[2].pages).toEqual(reference);
    for (const page of reference.filter((p) => p !== 'edge-setup' && p !== 'commands')) expect(visiblePages('public')).not.toContain(page);
  });

  test('deleted pages are gone from the sidebar', () => {
    for (const page of ['credentials', 'connector', 'development', 'dev/environment', 'security', 'proxmox']) {
      expect(ALL_PAGES).not.toContain(page);
    }
  });

  test('direct access stays in development: built only with DOCS_SCOPE=all', () => {
    const dev = ['direct-access', 'machine-cloudflare', 'machine-tailscale'];
    for (const page of dev) expect(visiblePages('public')).not.toContain(page);
    expect(visibleSections('all').at(-1)).toEqual({
      label: 'In development',
      labelFr: 'En cours de développement',
      pages: dev,
    });
  });

  test('a public build loads only the public files', () => {
    const pattern = contentPattern('public');
    expect(Array.isArray(pattern)).toBe(true);
    expect([...pattern].sort()).toEqual(
      [...PUBLIC_PAGES].flatMap((p) => [`docs/${p}.mdx`, `fr/docs/${p}.mdx`]).sort(),
    );
  });
});

describe('docsSlugOf', () => {
  test('a French link maps to the same slug as the English one', () => {
    expect(docsSlugOf('/fr/docs')).toBe('index');
    expect(docsSlugOf('/fr/docs/operations#sauvegarde')).toBe('operations');
    expect(docsSlugOf('/fr/other')).toBeNull();
  });

  test('maps internal docs hrefs to page slugs', () => {
    expect(docsSlugOf('/docs')).toBe('index');
    expect(docsSlugOf('/docs/')).toBe('index');
    expect(docsSlugOf('/docs/getting-started')).toBe('getting-started');
    expect(docsSlugOf('/docs/getting-started/#codes-de-sortie')).toBe('getting-started');
    expect(docsSlugOf('/docs/reference/nested?x=1')).toBe('reference/nested');
  });

  test('ignores every other href', () => {
    expect(docsSlugOf('/install')).toBeNull();
    expect(docsSlugOf('/docsearch')).toBeNull();
    expect(docsSlugOf('#instances-nommées')).toBeNull();
    expect(docsSlugOf('https://docs.openedbot.app/docs/edge-setup')).toBeNull();
  });
});
