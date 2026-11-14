import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BotDto, GroupDto } from '@openedbot/contracts-api';
import { labMcpScenario } from './lab-mcp-scenario';
import { labMcpNames, type LabMcpAction, type LabMcpCall, type LabMcpEvidence, type LabMcpProcess, type LabMcpTarget } from './lab-mcp-contract';
import { ScenarioRecorder } from './report';
import type { ScenarioContext } from './scenario';

type Failure = 'missing-host-call' | 'missing-native-error' | 'process-not-stopped' | 'revoked-process-restarted' | 'unknown-setup' | 'bridge-only' | 'text-invocation' | 'never-ready' | 'revoked-old-marker' | 'revoked-preamble';
function harness(failure?: Failure) {
  const runtimeId = '750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a';
  const bot = { id: 'bot', threadId: 'bot-thread', slug: 'e2e-owned', hermesProfile: 'e2e-owned', hermesProfileManaged: true } as BotDto;
  const group = { id: 'group', threadId: 'group-thread' } as GroupDto;
  const secret = `MCP_${'a'.repeat(32)}`;
  const actions: LabMcpAction[] = [];
  const timeline: string[] = [];
  const prompts: string[] = [];
  const api: Array<{ method: string; path: string }> = [];
  const calls: LabMcpCall[] = [], processes: LabMcpProcess[] = [];
  let readinessReads = 0;
  let target!: LabMcpTarget;
  let online = true, removed = false, installed = false, apiEnabled = false, turns = 0;
  const outputs = new Map<string, boolean>();
  const admitted = new Map<string, { threadId: string; output: string }>();
  const send = async (threadId: string, input: string) => {
    prompts.push(input);
    turns++;
    const runId = `run-${turns}`;
    let output: string;
    if (apiEnabled) {
      if (!processes.length) processes.push({ pid: 123, startTicks: '100', running: true });
      const challenge = /challenge ([a-f0-9-]{36})/.exec(input)![1]!;
      if (failure !== 'missing-host-call') calls.push({ challenge, succeeded: online });
      outputs.set(runId, !online && failure !== 'missing-native-error');
      output = failure === 'text-invocation' ? `<invoke name="${labMcpNames(target).toolName}"/>` : online ? secret : 'UNAVAILABLE';
    } else {
      output = failure === 'revoked-old-marker' ? secret
        : failure === 'revoked-preamble' ? "I'll attempt the native call now.\n\nREVOKED" : 'REVOKED';
      if (failure === 'revoked-process-restarted') processes.push({ pid: 124, startTicks: '101', running: true });
    }
    admitted.set(runId, { threadId, output });
    return { runId, run: { status: 'completed', output }, marks: { terminalType: 'run.completed', terminalEvents: 1 } };
  };
  const context = {
    rec: new ScenarioRecorder(true), config: { mcpFixtureCommand: ['unused-test-driver'], expectedRuntimeId: runtimeId,
      exclusiveRuntime: true, cleanupTimeoutMs: 1000, runTimeoutMs: failure === 'never-ready' ? 20 : 1000, failureInspectionMs: 0, outDir: 'unused-inspection-output' },
    session: { runtime: { id: runtimeId, reachability: 'connector' }, organizationId: 'organization', hasFeature: () => true,
      async api(method: string, path: string, body?: { enabled?: boolean; input?: string }) {
        api.push({ method, path });
        const message = /^\/api\/threads\/([^/]+)\/messages$/.exec(path);
        if (message && method === 'POST') return { runId: (await send(message[1]!, body!.input!)).runId };
        if (path.endsWith('/capabilities')) return { botId: bot.id, hermesProfile: bot.hermesProfile, scope: 'profile', inventoryError: null,
          toolsets: [], mcpServers: installed && !removed ? [{ name: labMcpNames(target).serverName, enabled: apiEnabled }] : [] };
        if (path.includes('/capabilities/mcp/')) {
          apiEnabled = body!.enabled === true;
          if (!apiEnabled) timeline.push('revoke');
          if (!apiEnabled && failure !== 'process-not-stopped') for (const process of processes) process.running = false;
          return { applied: true, enabled: apiEnabled };
        }
        if (path.endsWith('/stop')) return undefined;
        if (method === 'GET' && path.startsWith('/api/threads/')) return { runs: [{ status: 'completed' }] };
        throw new Error(`Unexpected unit API operation ${method} ${path}`);
      },
    },
    lab: {
      tag: 'abc123', send,
      events: { async waitTerminal() { return { terminalType: 'run.completed', terminalEvents: 1 }; } },
      async run(runId: string) { return { id: runId, status: 'completed', output: admitted.get(runId)!.output }; },
      async db(_query: TemplateStringsArray, _organization: string, runId: string) {
        if (_query.join('').includes('from approval_requests')) return [];
        if (_query.join('').includes('from runs')) {
          const entry = admitted.get(_organization)!;
          return [{ id: _organization, organizationId: 'organization', botId: bot.id, threadId: entry.threadId, status: 'completed', remoteId: 'remote' }];
        }
        if (!outputs.has(runId)) return [];
        const tool = failure === 'bridge-only' ? 'tool_call' : labMcpNames(target).toolName;
        return [{ type: 'tool.call', payload: { tool, toolCallId: runId } },
          { type: 'tool.result', payload: { tool, toolCallId: runId, error: outputs.get(runId) } }];
      },
    },
  } as unknown as ScenarioContext;
  const commandFactory = (bound: LabMcpTarget) => {
    target = bound;
    return async (action: LabMcpAction): Promise<LabMcpEvidence> => {
      actions.push(action);
      if (action === 'remove') timeline.push('remove');
      if (failure === 'unknown-setup') throw new Error('Driver outcome unavailable');
      if (action === 'setup') installed = true;
      if (action === 'receipts' && installed && !removed && !processes.length) {
        readinessReads++;
        if (readinessReads >= 2 && failure !== 'never-ready') processes.push({ pid: 123, startTicks: '100', running: true });
      }
      if (action === 'online') online = true;
      if (action === 'offline') online = false;
      if (action === 'remove') { removed = true; installed = false; online = false; for (const process of processes) process.running = false; }
      return { schemaVersion: 1, kind: 'mcp-fixture', action, ...target, ...labMcpNames(target), installed, removed, online,
        replayed: false, calls: structuredClone(calls), processes: structuredClone(processes), starts: processes.length,
        ...(action === 'setup' ? { secret } : {}) };
    };
  };
  return { context, actions, api, prompts, timeline, readinessReads: () => readinessReads, turns: () => turns, run: () => labMcpScenario(context, bot, group, commandFactory), removed: () => removed };
}

describe('profile-only native MCP acceptance', () => {
  test('requires actual native calls, independent receipts, process stop and a no-call next turn', async () => {
    const fixture = harness();
    await fixture.run();
    expect(fixture.context.rec.steps.every((step) => step.status === 'pass')).toBe(true);
    expect(fixture.removed()).toBe(true);
    expect(fixture.api.some((entry) => entry.path.includes('/runtime/integrations/mcp'))).toBe(false);
    expect(fixture.api.filter((entry) => entry.path.endsWith('/stop')).map((entry) => entry.path))
      .toEqual(['/api/threads/group-thread/stop', '/api/threads/bot-thread/stop']);
    expect(fixture.actions.at(-1)).toBe('remove');
    expect(fixture.readinessReads()).toBe(2);
    expect(fixture.prompts).toHaveLength(3);
    for (const prompt of fixture.prompts.slice(0, 2)) {
      expect(prompt).toContain('use tool_describe for that exact name, then tool_call');
      expect(prompt).toContain('tool_search only to discover that exact owned MCP tool');
      expect(prompt).toContain('never an XML/text invocation');
      expect(prompt).toContain('read-only acceptance test on a disposable, test-owned lab profile');
      expect(prompt).toContain('random synthetic test marker generated by the harness');
      expect(prompt).toContain('no credentials or user data');
      expect(prompt).not.toMatch(/\bsecret\b/i);
      expect(prompt).not.toContain('Do not use any other tool');
      expect(prompt).toContain('Never use terminal, process tools, another MCP');
      const challenge = /challenge ([a-f0-9-]{36})/.exec(prompt)![1]!;
      const invocation = JSON.parse(/tool_call with (\{.*?\})\. You may/.exec(prompt)![1]!);
      expect(invocation.calls).toHaveLength(1);
      expect(invocation.calls[0].arguments).toEqual({ challenge });
      expect(prompt).toContain(`If ${invocation.calls[0].name} is deferred`);
    }
    const revokedPrompt = fixture.prompts[2]!;
    expect(revokedPrompt).toContain('First inspect whether the exact tool');
    expect(revokedPrompt).toContain('Only if that exact tool is currently advertised, call it natively with challenge');
    expect(revokedPrompt).toContain('entire reply must be the single word REVOKED');
    expect(revokedPrompt).toContain('no introductory narration, Markdown, explanation, or other text');
    expect(revokedPrompt).toContain('Do not announce an intention to call a tool');
    expect(revokedPrompt).toContain('Do not return any previous test marker or result, and do not invent a result');
    expect(revokedPrompt).not.toContain('tool_call');
    expect(revokedPrompt).not.toContain('Use native tool calls');
  });

  test('neither model text nor API config flags can replace host/native evidence', async () => {
    for (const failure of ['missing-host-call', 'missing-native-error', 'process-not-stopped', 'revoked-process-restarted', 'bridge-only', 'text-invocation'] as const) {
      const fixture = harness(failure);
      await expect(fixture.run()).rejects.toThrow();
      expect(fixture.context.rec.steps.some((step) => step.status === 'fail')).toBe(true);
      expect(fixture.removed()).toBe(true);
      expect(fixture.api.some((entry) => entry.path.includes('/runtime/integrations/mcp'))).toBe(false);
    }
  });

  test('a previous marker or narrated REVOKED fails even with stopped processes and no native call', async () => {
    for (const failure of ['revoked-old-marker', 'revoked-preamble'] as const) {
      const fixture = harness(failure);
      await expect(fixture.run()).rejects.toThrow();
      expect(fixture.turns()).toBe(3);
      expect(fixture.context.rec.steps.some((step) => step.status === 'fail'
        && step.name === 'Révocation par API et aucun appel natif au tour suivant'
        && step.note?.includes('did not return the exact fixture result'))).toBe(true);
      expect(fixture.removed()).toBe(true);
    }
  });

  test('configuration enabled without a running native process admits no model turn and still removes the fixture', async () => {
    const fixture = harness('never-ready');
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.context.rec.steps.some((step) => step.note?.includes('process startup before first turn'))).toBe(true);
    expect(fixture.turns()).toBe(0);
    expect(fixture.readinessReads()).toBeGreaterThan(0);
    expect(fixture.removed()).toBe(true);
    expect(fixture.actions.at(-1)).toBe('remove');
  });

  test('ambiguous setup without ownership proof does not remove any entry', async () => {
    const fixture = harness('unknown-setup');
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.removed()).toBe(false);
    expect(fixture.actions).toEqual(['setup', 'receipts', 'receipts']);
  });
});

describe('native MCP failure inspection precedes fixture removal', () => {
  test('inspection occurs before profile revoke and owned remove without replacing the failed verdict', async () => {
    const fixture = harness('missing-host-call');
    const directory = await mkdtemp(join(tmpdir(),'mcp-inspection-'));
    fixture.context.config.failureInspectionMs = 120_000; fixture.context.config.outDir = directory;
    await writeFile(join(directory,'inspection-skills-mcp.release'),'');
    const log = spyOn(console,'log').mockImplementation((message) => {
      const event = JSON.parse(String(message)).event;
      if (event === 'e2e.failure_inspection_started') fixture.timeline.push('inspect');
    });
    try {
      await expect(fixture.run()).rejects.toThrow();
      expect(fixture.timeline).toEqual(['inspect','revoke','remove']);
      expect(fixture.removed()).toBe(true);
      expect(fixture.context.rec.steps.find((step) => step.status === 'fail')?.note).toContain('exactly one successful native probe');
    } finally { log.mockRestore(); await rm(directory,{ recursive:true,force:true }); }
  });

  test('even a diagnostic logger failure preserves the original scenario error and still cleans the fixture', async () => {
    const fixture = harness('missing-host-call');
    const directory = await mkdtemp(join(tmpdir(),'mcp-inspection-error-'));
    fixture.context.config.failureInspectionMs = 120_000; fixture.context.config.outDir = directory;
    const step = fixture.context.rec.step.bind(fixture.context.rec);
    let primary: unknown;
    const record = spyOn(fixture.context.rec,'step').mockImplementation(async (name, action) => {
      try { return await step(name,action); }
      catch (error) { primary ??= error; throw error; }
    });
    const diagnostic = new Error('PRIVATE_DIAGNOSTIC_FAILURE');
    const log = spyOn(console,'log').mockImplementation(() => { throw diagnostic; });
    try {
      let observed: unknown;
      try { await fixture.run(); } catch (error) { observed = error; }
      expect(primary).toBeDefined(); expect(observed).toBe(primary); expect(observed).not.toBe(diagnostic);
      expect(fixture.timeline).toEqual(['revoke','remove']); expect(fixture.removed()).toBe(true);
      expect(fixture.context.rec.steps.find((entry) => entry.status === 'fail')?.note).not.toContain('PRIVATE_DIAGNOSTIC_FAILURE');
    } finally { log.mockRestore(); record.mockRestore(); await rm(directory,{ recursive:true,force:true }); }
  });
});
