import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotComputerDto } from '@openedbot/contracts-api';
import { ToolFixture, pdfWriterScript } from './tool-fixture';
import { assertIsolatedMemory, assertPdf, removalScript, successfulTool, type ToolEvent } from './tool-proof';
import { requireBrowserBinding } from '../scenarios/browser-action';

const call = (id: string, tool = 'read_file'): ToolEvent => ({ type: 'tool.call', payload: { toolCallId: id, tool } });
const result = (id: string, error: unknown = false, tool = 'read_file', excerpt = 'hidden-nonce'): ToolEvent => ({ type: 'tool.result', payload: { toolCallId: id, tool, error, resultExcerpt: excerpt } });

describe('independent tool evidence', () => {
  test('requires an ordered successful matching pair and the hidden value', () => {
    expect(successfulTool([call('a'), result('a'), result('a')], 'read_file', 'hidden-nonce')).toBe(1);
    for (const events of [[], [result('a')], [result('a'), call('a')], [call('a'), result('b')], [call('a'), result('a', true)], [call('a'), result('a', null)], [call('a'), result('a', false, 'terminal')], [call('a'), result('a', false, 'read_file', 'different')]]) {
      expect(() => successfulTool(events, 'read_file', 'hidden-nonce')).toThrow('No successful');
    }
  });

  test('uses only an unambiguous transcript result attached after its successful completion', () => {
    const completion = result('a', false, 'read_file', '');
    const attached: ToolEvent = { type: 'tool.result.attached', payload: { tool: 'read_file', toolCallId: 'a', result: { text: 'hidden-nonce' } } };
    expect(successfulTool([call('a'), completion, attached], 'read_file', 'hidden-nonce')).toBe(1);
    for (const history of [
      [call('a'), attached, completion],
      [call('a'), result('a', true), attached],
      [call('a'), completion, { ...attached, payload: { ...attached.payload, ambiguous: true } }],
      [call('a'), completion, { ...attached, payload: { ...attached.payload, toolCallId: 'other' } }],
    ]) expect(() => successfulTool(history, 'read_file', 'hidden-nonce')).toThrow();
  });

  test('rejects leaked or missing memory even when another profile looks correct', () => {
    expect(() => assertIsolatedMemory(['a'], ['b'], 'a', 'b')).not.toThrow();
    for (const [a, b] of [[[], ['b']], [['a'], []], [['a', 'b'], ['b']], [['a'], ['a', 'b']]]) {
      expect(() => assertIsolatedMemory(a ?? [], b ?? [], 'a', 'b')).toThrow();
    }
  });

  test('validates the actual Python PDF output and rejects false claims or a damaged xref', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openedbot-pdf-fixture-'));
    try {
      const source = join(dir, 'source.txt'), pdf = join(dir, 'proof.pdf');
      const expected = '0123456789ABCDEF0123456789ABCDEF';
      await writeFile(source, expected);
      const child = Bun.spawn(['python3', '-c', pdfWriterScript(source, pdf)], { stdout: 'pipe', stderr: 'pipe' });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      const bytes = new Uint8Array(await readFile(pdf));
      expect(() => assertPdf(bytes, expected)).not.toThrow();
      expect(() => assertPdf(bytes, 'WRONG')).toThrow('exact transformed');
      const fake = new TextEncoder().encode(`%PDF-1.4\n(${expected}) Tj\n%%EOF`);
      expect(() => assertPdf(fake, expected)).toThrow('cross-reference');
      const damaged = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('0000000009 00000 n', '0000000000 00000 n'));
      expect(() => assertPdf(damaged, expected)).toThrow('offsets');
      expect(() => assertPdf(bytes.subarray(0, bytes.length - 12), expected)).toThrow('bounded PDF');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('cleanup accepts only exact owned filenames and never a directory or traversal', () => {
    expect(removalScript(['/workspace/e2e-source-tag.txt', 'e2e-isolation-tag.txt'])).toContain('missing_ok=True');
    for (const paths of [[], ['/workspace'], ['/workspace/../e2e-a'], ['/workspace/e2e-a/child'], ['/tmp/operator.txt'], ['~/.ssh'], ['e2e-a\nfile'], ['/workspace/e2e-*']]) expect(() => removalScript(paths)).toThrow('Refusing');
  });
});

describe('controlled HTTP fixture', () => {
  test('requires an explicit clean origin', () => {
    for (const origin of [null, 'file:///tmp/', 'http://user:pass@host', 'https://host/path', 'https://host/?token=x']) {
      expect(() => ToolFixture.start({ fixtureOrigin: origin, fixturePort: 0 })).toThrow();
    }
  });

  test('serves only the private source and records actual reads without caching', async () => {
    const fixture = ToolFixture.start({ fixtureOrigin: 'http://lab.example:18871', fixturePort: 0 });
    try {
      const source = fixture.source();
      const local = `http://127.0.0.1:${fixture.port}${new URL(source.url).pathname}`;
      expect(source.reads).toBe(0);
      expect((await fetch(`http://127.0.0.1:${fixture.port}/source.txt`)).status).toBe(404);
      expect((await fetch(local, { method: 'POST' })).status).toBe(405);
      expect(source.reads).toBe(0);
      const response = await fetch(local);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(`${source.value}\n`);
      expect(source.reads).toBe(1);
    } finally { await fixture.stop(); }
  });
});

describe('browser target evidence', () => {
  const computer: BotComputerDto = { botId: 'bot', canManage: true, provider: 'box', providerState: 'running', observation: { capability: { supported: true, canOpen: true, canCapture: true }, status: { status: 'ready' } }, agentControl: { status: 'unavailable', reason: 'COMPUTER_AGENT_CONTROL_NOT_BOUND' } };
  test('a ready viewer does not prove agent control on the bot computer', () => {
    expect(() => requireBrowserBinding(computer, 'bot')).toThrow('COMPUTER_AGENT_CONTROL_NOT_BOUND');
    expect(() => requireBrowserBinding(computer, 'other')).toThrow('another bot');
    expect(() => requireBrowserBinding({ ...computer, provider: null, agentControl: { status: 'unavailable', reason: 'COMPUTER_PROVIDER_DISABLED' } }, 'bot')).toThrow('COMPUTER_PROVIDER_DISABLED');
  });
});
