import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { satteri } from '@astrojs/markdown-satteri';

import {
  SITE_URL,
  pageUrl,
  readDocsScope,
  visiblePages,
  visibleSections,
} from './src/lib/docs-scope';
import { unlinkHiddenDocs } from './src/lib/unlink-hidden-docs';

// DOCS_SCOPE is read once, at build (or dev server) start. See README.md.
const scope = readDocsScope();
const visible = new Set(visiblePages(scope));

// Former Next.js redirects. A target this scope does not build falls back to
// the docs index rather than to a 404.
const LEGACY_REDIRECTS: Record<string, string> = {
  '/docs/modes': 'getting-started',
  '/docs/install': 'getting-started',
  '/docs/changelog': 'index',
  '/docs/provenance': 'index',
};
const redirects: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_REDIRECTS).map(([from, page]) => [
    from,
    pageUrl(visible.has(page) ? page : 'index'),
  ]),
);

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  trailingSlash: 'ignore',
  redirects,
  markdown: {
    // Keep the French text verbatim: no smart quotes or dashes.
    processor: satteri({
      features: { smartPunctuation: false },
      hastPlugins: [unlinkHiddenDocs(visible)],
    }),
  },
  integrations: [
    starlight({
      title: 'openedbot',
      description:
        'Your AI assistants, on a machine you own. Create an account, link your server, talk to your bots from the console.',
      logo: { src: './src/assets/ohb-icon.webp', alt: '' },
      favicon: '/favicon.ico',
      // English is the default, at the root; French under /fr/ (docs-scope.ts).
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        fr: { label: 'Français', lang: 'fr' },
      },
      disable404Route: true,
      components: {
        // The site's EN | FR switch instead of Starlight's select.
        LanguageSelect: './src/components/starlight/LanguageSelect.astro',
      },
      sidebar: visibleSections(scope).map((section) => ({
        label: section.label,
        translations: { fr: section.labelFr },
        items: section.pages.map((page) => (page === 'index' ? 'docs' : `docs/${page}`)),
      })),
      customCss: [
        '@fontsource-variable/inter',
        '@fontsource/jetbrains-mono/400.css',
        './src/styles/docs.css',
      ],
    }),
  ],
});
