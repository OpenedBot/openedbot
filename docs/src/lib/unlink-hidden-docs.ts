import { defineHastPlugin } from 'satteri';

/** Page slug targeted by an internal docs href, or null for any other href. */
export function docsSlugOf(href: string): string | null {
  // A French page links to `/fr/docs/...`: same slug as the English page.
  const path = (href.split(/[?#]/, 1)[0] ?? '').replace(/^\/fr(?=\/docs(\/|$))/, '');
  if (path !== '/docs' && !path.startsWith('/docs/')) return null;
  const slug = path.slice('/docs'.length).replace(/^\/+|\/+$/g, '');
  return slug === '' ? 'index' : slug;
}

/**
 * Replaces a link to a docs page this build does not publish with its text,
 * so a `public` build never links to an operator page. The source files keep
 * the link: an `all` build renders it.
 */
export function unlinkHiddenDocs(visible: ReadonlySet<string>) {
  return defineHastPlugin({
    name: 'unlink-hidden-docs',
    element: {
      filter: ['a'],
      visit(node, ctx) {
        const href = node.properties?.href;
        if (typeof href !== 'string') return;
        const slug = docsSlugOf(href);
        if (slug === null || visible.has(slug)) return;
        ctx.replaceNode(node, [...node.children]);
      },
    },
  });
}
