import { getCollection, type CollectionEntry } from 'astro:content';

import { DOCS_TREE_TITLE, SIDEBAR_SECTIONS, collectionId } from './docs-scope';
import { docsSlugOf } from './unlink-hidden-docs';

type DocsEntry = CollectionEntry<'docs'>;

/** Page URL without trailing slash, as the former site published it. */
function llmsUrl(page: string): string {
  return page === 'index' ? '/docs' : `/docs/${page}`;
}

function markdownLink(title: string, url: string): string {
  return `[${title.replace(/([[\]])/g, '\\$1')}](${url.replace(/([()])/g, '\\$1')})`;
}

function listItem(name: string, description: string): string {
  const text = description.trim();
  return text.length > 0 ? `- ${name}: ${text}` : `- ${name}`;
}

/** Built pages, grouped and ordered as in the sidebar. */
async function sections(): Promise<{ label: string; pages: { page: string; entry: DocsEntry }[] }[]> {
  const byId = new Map((await getCollection('docs')).map((entry) => [entry.id, entry]));
  return SIDEBAR_SECTIONS.map((section) => ({
    label: section.label,
    pages: section.pages.flatMap((page) => {
      const entry = byId.get(collectionId(page));
      return entry ? [{ page, entry }] : [];
    }),
  })).filter((section) => section.pages.length > 0);
}

/** llms.txt: the same index the Fumadocs `llms(source).index()` produced. */
export async function llmsIndex(): Promise<string> {
  const out = [`# ${DOCS_TREE_TITLE}`, ''];
  for (const section of await sections()) {
    out.push('\n' + listItem(`**${section.label}**`, ''));
    for (const { page, entry } of section.pages) {
      out.push(listItem(markdownLink(entry.data.title, llmsUrl(page)), entry.data.description ?? ''));
    }
  }
  return out.join('\n');
}

const ASIDE_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  caution: 'Caution',
  danger: 'Danger',
};

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`).exec(attributes)?.slice(1).find((value) => value !== undefined);
}

/** One prose line without its component tags; inline code spans are left as written. */
function stripLineTags(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/<Aside\b([^>]*)>/g, (_tag: string, attributes: string) => {
              const label = ASIDE_LABELS[attribute(attributes, 'type') ?? 'note'] ?? 'Note';
              const title = attribute(attributes, 'title');
              return title ? `${label}: ${title}` : `${label}:`;
            })
            .replace(/<\/?[A-Z][\w.]*(?:\s[^>]*)?\/?>/g, ''),
    )
    .join('');
}

/**
 * MDX component tags reduced to their text, as a reader of the HTML sees it:
 * an `<Aside>` becomes a "Caution: <title>" line, any other component tag
 * disappears and keeps its content. Fenced code is left untouched, so a
 * `<TOKEN>` placeholder in a command survives.
 */
export function stripComponentTags(body: string): string {
  let fence: string | null = null;
  const lines = body.split('\n').map((line) => {
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trimEnd() === marker) fence = null;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    return stripLineTags(line);
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Page source for an LLM: the MDX body without the component imports this
 * site adds after the front matter, without component tags, and with a link
 * to a page this build does not publish reduced to its text (as the HTML does).
 */
function pageText(entry: DocsEntry, published: ReadonlySet<string>): string {
  const body = (entry.body ?? '')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (link: string, text: string, href: string) => {
      const slug = docsSlugOf(href);
      return slug === null || published.has(slug) ? link : text;
    })
    .replace(/^\s*(?:import [^\n]+ from '[^']+';\n)+/, '')
    .replace(/^\n+/, '');
  return stripComponentTags(body).trimEnd();
}

/** llms-full.txt: every built page, in sidebar order. */
export async function llmsFull(): Promise<string> {
  const pages = (await sections()).flatMap((section) => section.pages);
  const published = new Set(pages.map(({ page }) => page));
  return pages
    .map(({ page, entry }) => `# ${entry.data.title} (${llmsUrl(page)})\n\n${pageText(entry, published)}`)
    .join('\n\n');
}
