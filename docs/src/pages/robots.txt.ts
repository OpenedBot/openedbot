import type { APIRoute } from 'astro';

import { SITE_URL } from '../lib/docs-scope';

export const GET: APIRoute = () =>
  new Response(
    [
      'User-Agent: *',
      'Allow: /',
      '',
      `Host: ${SITE_URL}`,
      `Sitemap: ${new URL('/sitemap-index.xml', SITE_URL)}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
