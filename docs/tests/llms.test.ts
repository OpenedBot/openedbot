import { describe, expect, mock, test } from 'bun:test';

// llms.ts reads the content collection through Astro's virtual module; the
// tests hand it one English page instead.
const PAGE_BODY = [
  "import { Aside } from '@astrojs/starlight/components';",
  '',
  'Intro text.',
  '',
  '<Aside type="caution" title="A dedicated machine">',
  'Dedicate a machine to `edge-setup`.',
  '</Aside>',
  '',
  '```bash',
  'sudo cloudflared service install <TOKEN>',
  '```',
  '',
  'Done.',
].join('\n');

mock.module('astro:content', () => ({
  getCollection: async () => [
    { id: 'docs/edge-setup', body: PAGE_BODY, data: { title: 'edge-setup', description: 'The tool.' } },
  ],
}));

const { llmsFull, stripComponentTags } = await import('../src/lib/llms');

describe('stripComponentTags', () => {
  test('turns an Aside into a labelled line and drops its closing tag', () => {
    expect(stripComponentTags('<Aside type="caution" title="Old address">\nBody.\n</Aside>\n\nNext.')).toBe(
      'Caution: Old address\nBody.\n\nNext.',
    );
  });

  test('labels an Aside without title or type as a note', () => {
    expect(stripComponentTags('<Aside>\nBody.\n</Aside>')).toBe('Note:\nBody.\n');
  });

  test('removes self-closing and other component tags but keeps their text', () => {
    expect(stripComponentTags('<TrustFlow />\n<Steps>\n1. One\n</Steps>')).toBe('\n\n1. One\n');
  });

  test('leaves fenced code and inline code spans as written', () => {
    const source = '```bash\nsudo tailscale up --auth-key <KEY>\n```\nUse `<Aside>` here.';
    expect(stripComponentTags(source)).toBe(source);
  });

  test('keeps a fence opened by more backticks open until a matching close', () => {
    const source = '````md\n```\n<Aside>\n```\n````\n<Aside>';
    expect(stripComponentTags(source)).toBe('````md\n```\n<Aside>\n```\n````\nNote:');
  });
});

describe('llmsFull', () => {
  test('publishes the page without imports or raw component tags', async () => {
    const text = await llmsFull();
    expect(text).toContain('# edge-setup (/docs/edge-setup)');
    expect(text).toContain('Caution: A dedicated machine\nDedicate a machine to `edge-setup`.');
    expect(text).toContain('sudo cloudflared service install <TOKEN>');
    expect(text).not.toContain('<Aside');
    expect(text).not.toContain('</Aside>');
    expect(text).not.toContain('import {');
  });
});
