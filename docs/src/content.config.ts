import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { docsSchema } from '@astrojs/starlight/schema';

import { contentPattern, readDocsScope } from './lib/docs-scope';

// Same files and ids as Starlight's docsLoader, restricted to the pages the
// DOCS_SCOPE build publishes: a hidden page never enters the collection.
export const collections = {
  docs: defineCollection({
    loader: glob({ base: './src/content/docs', pattern: contentPattern(readDocsScope()) }),
    schema: docsSchema({
      extend: z.object({
        // Former Fumadocs frontmatter, kept verbatim: a Lucide icon name and
        // the full-width flag (rendered here as `tableOfContents: false`).
        icon: z.string().optional(),
        full: z.boolean().optional(),
      }),
    }),
  }),
};
