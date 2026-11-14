// Which documentation pages a build publishes.
//
// `public` (the default, used for production) serves the console user guide
// plus the edge-setup and command reference pages. Everything else is developer reference
// (prerequisites, operations, reset, troubleshooting) or a path
// still in development (direct access through Cloudflare or Tailscale) and is
// built only with `DOCS_SCOPE=all`, the default of `bun run dev`. A hidden page is never built, so it is
// absent from the sidebar, the sitemap, the search index and llms.txt; a link
// to it from a public page is unwrapped to plain text (see
// `unlink-hidden-docs.ts`).

export type DocsScope = 'public' | 'all';

export function readDocsScope(value: string | undefined = process.env.DOCS_SCOPE): DocsScope {
  if (value === undefined || value === '' || value === 'public') return 'public';
  if (value === 'all') return 'all';
  throw new Error(`DOCS_SCOPE must be "public" or "all", got ${JSON.stringify(value)}`);
}

export const SITE_URL = 'https://docs.openedbot.app';

/** Root title of the docs tree (the `title` of the former `meta.json`). */
export const DOCS_TREE_TITLE = 'openedbot';

/**
 * Languages of the site. English is the default and lives at the root
 * (`/docs/<page>`, content in `src/content/docs/docs/`); French lives under
 * `/fr/` (content in `src/content/docs/fr/docs/`). Page file names are the
 * same in both languages: they are the URLs, and code links to them.
 */
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

// Page slugs below `docs/` (the file name without `.mdx`; `index` is /docs).
// Order and section labels mirror the former `content/docs/meta.json`.
export const SIDEBAR_SECTIONS: readonly { label: string; labelFr: string; pages: readonly string[] }[] = [
  {
    label: 'Using openedbot',
    labelFr: 'Utiliser openedbot',
    pages: [
      'index',
      'compte',
      'machine',
      'bot',
      'conversation',
      'reglages',
    ],
  },
  {
    label: 'Help',
    labelFr: 'Aide',
    pages: ['depannage', 'faq', 'confiance', 'support'],
  },
  {
    label: 'Reference',
    labelFr: 'Référence',
    pages: ['prerequisites', 'getting-started', 'edge-setup', 'commands', 'operations', 'troubleshooting', 'reset'],
  },
  {
    // Direct access (Cloudflare managed tunnel, Tailscale Funnel): not
    // published until the path is ready, so never in a `public` build.
    label: 'In development',
    labelFr: 'En cours de développement',
    pages: ['direct-access', 'machine-cloudflare', 'machine-tailscale'],
  },
];

/** Pages published by a `public` build (the former PUBLIC_PAGE_FILES). */
export const PUBLIC_PAGES: ReadonlySet<string> = new Set([
  'index',
  'compte',
  'machine',
  'bot',
  'conversation',
  'reglages',
  'depannage',
  'faq',
  'confiance',
  'support',
  'edge-setup',
  'commands',
]);

export const ALL_PAGES: readonly string[] = SIDEBAR_SECTIONS.flatMap((section) => section.pages);

export function visiblePages(scope: DocsScope): readonly string[] {
  return scope === 'all' ? ALL_PAGES : ALL_PAGES.filter((page) => PUBLIC_PAGES.has(page));
}

/** Sections with their visible pages; a section left empty is dropped. */
export function visibleSections(scope: DocsScope): { label: string; labelFr: string; pages: string[] }[] {
  const visible = new Set(visiblePages(scope));
  return SIDEBAR_SECTIONS.map((section) => ({
    label: section.label,
    labelFr: section.labelFr,
    pages: section.pages.filter((page) => visible.has(page)),
  })).filter((section) => section.pages.length > 0);
}

/** Path prefix of a language: none for English, `/fr` for French. */
export function localePrefix(locale: Locale = 'en'): string {
  return locale === 'en' ? '' : `/${locale}`;
}

/** URL path of a page slug: `index` is `/docs/`, `faq` is `/docs/faq/`. */
export function pageUrl(page: string, locale: Locale = 'en'): string {
  return `${localePrefix(locale)}${page === 'index' ? '/docs/' : `/docs/${page}/`}`;
}

/** Content collection id of a page slug, as produced by the glob loader. */
export function collectionId(page: string, locale: Locale = 'en'): string {
  const base = page === 'index' ? 'docs' : `docs/${page}`;
  return locale === 'en' ? base : `${locale}/${base}`;
}

/** Glob pattern(s) of the content files a scope builds. */
export function contentPattern(scope: DocsScope): string | string[] {
  if (scope === 'all') return '**/[^_]*.{md,mdx}';
  return LOCALES.flatMap((locale) =>
    [...PUBLIC_PAGES].map((page) => `${locale === 'en' ? '' : `${locale}/`}docs/${page}.mdx`),
  );
}
