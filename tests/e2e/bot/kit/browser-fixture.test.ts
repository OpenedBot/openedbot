import { describe, expect, test } from 'bun:test';
import { ToolFixture, type BrowserFixturePage } from './tool-fixture';
import { proveRuntimeBrowserAction } from '../scenarios/browser-action';
import type { ToolEvent } from './tool-proof';

type Challenge = { encoded: number[]; ticket: string; botId: string; runId: string };
async function browserSession(fixture: ToolFixture, page: BrowserFixturePage) {
  const html = await fixture.respond(new Request(page.url));
  const cookie = html.headers.get('set-cookie')!.split(';')[0]!;
  const request = (endpoint: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`${page.url}/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, Origin: new URL(page.url).origin, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const challenge = await (await fixture.respond(request('bootstrap'))).json() as Challenge;
  const body = { ticket: challenge.ticket, botId: page.botId, runId: page.runId, value: page.value, witness: 'a'.repeat(32) };
  return { html, cookie, challenge, body, request };
}

describe('controlled browser action fixture', () => {
  test('requires exact bot/run binding and hides the dynamic challenge from initial HTML', async () => {
    const fixture = ToolFixture.start({ fixtureOrigin: 'http://fixture.example', fixturePort: 0 });
    try {
      expect(() => fixture.browserPage('../foreign')).toThrow('exact bot');
      const page = fixture.browserPage('bot-a');
      expect((await fixture.respond(new Request(page.url))).status).toBe(503);
      page.bindRun('run-a');
      expect(() => page.bindRun('run-b')).toThrow('rebound');
      const session = await browserSession(fixture, page);
      const html = await session.html.text();
      expect(html).not.toContain(page.value);
      expect(html).not.toContain(page.receipt);
      expect(html).toContain('event.isTrusted');
      expect(html).toContain('document.body.dataset.challenge');
      expect(session.html.headers.get('cache-control')).toBe('no-store');
      expect(session.html.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
      expect(session.challenge.runId).toBe('run-a');
      expect(String.fromCharCode(...session.challenge.encoded.map((byte) => byte ^ 23))).toBe(page.value);
    } finally { await fixture.stop(); }
  });

  test('a direct POST cannot claim success without page session and input witness', async () => {
    const fixture = ToolFixture.start({ fixtureOrigin: 'http://fixture.example', fixturePort: 0 });
    try {
      const page = fixture.browserPage('bot-a'); page.bindRun('run-a');
      expect((await fixture.respond(new Request(`${page.url}/submit`, { method: 'POST', body: '{}' }))).status).toBe(403);
      const session = await browserSession(fixture, page);
      expect((await fixture.respond(session.request('submit', session.body))).status).toBe(403);
      expect(page.interactions).toBe(0);
      expect(page.submissions).toEqual([]);
      for (const bad of [{ value: 'invented' }, { ticket: 'invented' }, { botId: 'foreign' }, { runId: 'foreign' }, { witness: 'invalid' }]) {
        expect((await fixture.respond(session.request('input', { ...session.body, ...bad }))).status).toBe(403);
      }
      expect((await fixture.respond(session.request('input', session.body, { Origin: 'https://foreign.example' }))).status).toBe(403);
      expect((await fixture.respond(session.request('input', session.body, { Cookie: 'foreign' }))).status).toBe(403);
      expect(page.submissions).toEqual([]);
    } finally { await fixture.stop(); }
  });

  test('records exactly one bound effect and rejects replay, malformed and oversized submissions', async () => {
    const fixture = ToolFixture.start({ fixtureOrigin: 'http://fixture.example', fixturePort: 0 });
    try {
      const page = fixture.browserPage('bot-a'); page.bindRun('run-a');
      const session = await browserSession(fixture, page);
      for (const invalid of [null, [], 'text']) {
        expect((await fixture.respond(session.request('input', invalid))).status).toBe(400);
      }
      const huge = { ...session.body, extra: 'x'.repeat(4096) };
      expect((await fixture.respond(session.request('input', huge))).status).toBe(413);
      expect((await fixture.respond(session.request('input', session.body))).status).toBe(200);
      expect((await fixture.respond(session.request('submit', { ...session.body, witness: 'b'.repeat(32) }))).status).toBe(403);
      const submitted = await fixture.respond(session.request('submit', session.body));
      expect(submitted.status).toBe(200);
      expect(await submitted.json()).toEqual({ receipt: page.receipt });
      expect(page.submissions).toEqual([{ botId: page.botId, runId: page.runId!, value: page.value, receipt: page.receipt }]);
      expect((await fixture.respond(session.request('submit', session.body))).status).toBe(409);
      expect(page.submissions).toHaveLength(1);
    } finally { await fixture.stop(); }
  });

  test('browser tool evidence, exact binding and independent effect are all required', async () => {
    const fixture = ToolFixture.start({ fixtureOrigin: 'http://fixture.example', fixturePort: 0 });
    try {
      const page = fixture.browserPage('bot-a'); page.bindRun('run-a');
      const session = await browserSession(fixture, page);
      const events: ToolEvent[] = [{ type: 'tool.call', payload: { tool: 'browser_exec', toolCallId: 'browser-call' } },
        { type: 'tool.result', payload: { tool: 'browser_exec', toolCallId: 'browser-call', error: false, resultExcerpt: page.receipt } }];
      const output = `${page.value} ${page.receipt}`;
      expect(() => proveRuntimeBrowserAction(events, output, page, 'bot-a', 'run-a')).toThrow('input interaction');
      await fixture.respond(session.request('input', session.body));
      await fixture.respond(session.request('submit', session.body));
      expect(proveRuntimeBrowserAction(events, output, page, 'bot-a', 'run-a')).toBe(1);
      expect(() => proveRuntimeBrowserAction(events, output, page, 'foreign', 'run-a')).toThrow('another bot or run');
      expect(() => proveRuntimeBrowserAction(events, output, page, 'bot-a', 'foreign')).toThrow('another bot or run');
      expect(() => proveRuntimeBrowserAction([], output, page, 'bot-a', 'run-a')).toThrow('No successful');
      expect(proveRuntimeBrowserAction([{ type: 'tool.call', payload: { tool: 'tool_search' } }, ...events], output, page, 'bot-a', 'run-a')).toBe(1);
      for (const tool of ['terminal', 'process', 'execute_code', 'web_extract']) {
        expect(() => proveRuntimeBrowserAction([...events, { type: 'tool.call', payload: { tool } }], output, page, 'bot-a', 'run-a')).toThrow('non-browser');
      }
      expect(() => proveRuntimeBrowserAction(events, 'Claimed success', page, 'bot-a', 'run-a')).toThrow('hidden DOM code');
    } finally { await fixture.stop(); }
  });
});
