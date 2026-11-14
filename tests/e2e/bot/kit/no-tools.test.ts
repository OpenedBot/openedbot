import { expect, test } from 'bun:test';
import type { BotDto } from '@openedbot/contracts-api';
import type { Session } from './session';
import { noTools } from './p1-evidence';

const bot = { id: 'owned', hermesProfile: 'e2e-owned' } as BotDto;
function fixture(options: { perpetual?: boolean; missingMcp?: boolean } = {}) {
  let tools = ['browser'], servers = ['owned-mcp'], reads = 0;
  const writes: string[] = [];
  const session = { async api(method: string, path: string) {
    if (method === 'GET') {
      reads++;
      return { scope: 'profile', hermesProfile: bot.hermesProfile, inventoryError: null,
        toolsets: tools.map(name => ({ name, enabled: true })),
        mcpServers: options.missingMcp ? null : servers.map(name => ({ name, enabled: true })) };
    }
    writes.push(path);
    if (path.includes('/toolsets/')) {
      const name = path.split('/').at(-1)!;
      tools = tools.filter(entry => entry !== name);
      // Match Hermes' empty-list composite fallback, then suppression.
      if (name === 'browser' || options.perpetual) tools = ['x_search'];
    } else servers = [];
    return { enabled: false, applied: true };
  } } as unknown as Session;
  return { session, writes, reads: () => reads };
}

test('disabling the last tool verifies and suppresses a newly exposed composite toolset', async () => {
  const state = fixture();
  await noTools(state.session, bot);
  expect(state.reads()).toBe(3);
  expect(state.writes).toEqual([
    '/api/bots/owned/capabilities/toolsets/browser',
    '/api/bots/owned/capabilities/mcp/owned-mcp',
    '/api/bots/owned/capabilities/toolsets/x_search',
  ]);
});

test('a nonconverging host fails within three mutation passes with actionable names', async () => {
  const state = fixture({ perpetual: true });
  await expect(noTools(state.session, bot)).rejects.toThrow('x_search');
  expect(state.reads()).toBe(4);
  expect(state.writes.filter(path => path.includes('/toolsets/'))).toHaveLength(3);
});

test('unreadable MCP inventory cannot masquerade as no enabled servers', async () => {
  const state = fixture({ missingMcp: true });
  await expect(noTools(state.session, bot)).rejects.toThrow('inventory is unavailable');
  expect(state.writes).toEqual([]);
});
