import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareGroupTurn } from '../../src/application/runner/rooms';
import { readRoomLinesNewestFirst, type RoomLine } from '../../src/application/runner/room-lines';
import type { RunContext } from '../../src/application/runner/types';
import type { MessageContent } from '@openedbot/contracts-api';
import { ATTACHMENT_LIMITS } from '@openedbot/conversation/domain/attachments';

const org = '11111111-1111-4111-8111-111111111111';
const thread = 'thread-owned';
const blobRoot = mkdtempSync(join(tmpdir(), 'room-reply-'));
afterAll(() => rmSync(blobRoot, { recursive: true, force: true }));
const context = { id: 'current-run', organizationId: org, threadId: thread, groupId: 'group-owned', workflowId: 'current-workflow',
  botId: 'bot-owned', botName: 'Reader', botSlug: 'reader', botDescription: null, stepIndex: 0, groupState: null,
  operator: { username: 'Operator' }, instructions: '', webToolsEnabled: false } as unknown as RunContext;
const chip = (id: string, name: string, kind: 'image' | 'document' = 'image', bytes = 4) => ({
  type: 'attachment' as const, id, name, kind, contentType: kind === 'image' ? 'image/png' : 'text/plain', bytes });
const line = (content: MessageContent, extra: Partial<RoomLine> = {}): RoomLine => ({
  role: 'user', authorBotId: null, authorName: null, authorSlug: null, content, sequence: 3, runId: context.id, ...extra });
const reply = (content: MessageContent, extra: Record<string, unknown> = {}) => ({
  id: 'source-message', organizationId: org, threadId: thread, role: 'user' as const, content, ...extra });
type FileRow = { id: string; name: string; contentType: string; kind: string; bytes: number; objectKey: string; ownerThread: string; deleted?: boolean };
function file(name: string, bytes: Uint8Array, kind: 'image' | 'document' = 'image', persist = true): FileRow {
  const id = crypto.randomUUID(), objectKey = `org/${org}/${id}`;
  if (persist) { mkdirSync(join(blobRoot, 'org', org), { recursive: true }); writeFileSync(join(blobRoot, objectKey), bytes); }
  return { id, name, contentType: kind === 'image' ? 'image/png' : 'text/plain', kind, bytes: bytes.length, objectKey, ownerThread: thread };
}
function fixture(lines: RoomLine[], files: FileRow[]) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = ((strings: TemplateStringsArray | string[], ...values: unknown[]) => {
    if (!('raw' in strings)) return strings;
    const sql = [...strings].join(' '); queries.push({ sql, values });
    if (sql.includes('from bot_groups')) return Promise.resolve([{ name: 'Controlled room', instructions: '' }]);
    if (sql.includes('from group_members')) return Promise.resolve([]);
    if (sql.includes('from group_member_read_positions')) return Promise.resolve([{ sequence: 2 }]);
    if (sql.includes('from messages reply')) {
      expect(sql).toContain('reply.organization_id ='); expect(sql).toContain('reply.thread_id =');
      expect(values).toContain(org); expect(values).toContain(thread);
      return Promise.resolve(lines.flatMap((entry) => entry.replyTarget ? [entry.replyTarget] : []));
    }
    if (sql.includes('from messages m')) return Promise.resolve([...lines].sort((a,b) => (b.sequence ?? 0)-(a.sequence ?? 0)));
    if (sql.includes('from attachments attachment')) {
      expect(sql).toContain('owner.id = attachment.message_id');
      expect(sql).toContain('owner.organization_id = attachment.organization_id');
      expect(sql).toContain('owner.thread_id ='); expect(values).toContain(thread); expect(values).toContain(org);
      const wanted = values.find(Array.isArray) as string[];
      return Promise.resolve(files.filter((row) => wanted.includes(row.id) && !row.deleted && row.ownerThread === thread));
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  return { db, queries, run: () => prepareGroupTurn(db, context, { driver: 'file', root: blobRoot } as never) };
}
function spoken(turn: Awaited<ReturnType<typeof prepareGroupTurn>>) {
  if (turn?.kind !== 'speak') throw new Error('Expected a speaking group turn.');
  return turn;
}

describe('explicit same-thread reply attachment rehydration', () => {
  test('old cited image and document are reread as bytes after text-only authoritative history; unrelated old image stays absent', async () => {
    const png = file('lower-row.png', new Uint8Array([137,80,78,71]));
    const doc = file('release.txt', new TextEncoder().encode('Recovery proof ONLY_IN_DOCUMENT'), 'document');
    const other = file('unrelated.png', new Uint8Array([1,2,3,4]));
    const target = reply([chip(png.id,png.name),chip(doc.id,doc.name,'document',doc.bytes)]);
    const f = fixture([
      line([chip(other.id,other.name)], { sequence: 1, runId: 'older-run' }),
      line([{ type: 'text', text: 'Read the lower row in the original attachment.' }], { replyToId: target.id, replyTarget: target }),
    ], [png,doc,other]);
    const turn = spoken(await f.run());
    expect(turn.images).toEqual([{ name: png.name, dataUrl: 'data:image/png;base64,iVBORw==' }]);
    expect(turn.input).toContain('ONLY_IN_DOCUMENT'); expect(turn.input).toContain('UNTRUSTED_REPLY_ATTACHMENTS_JSON=');
    expect(turn.history.every((entry) => typeof entry.content === 'string')).toBe(true);
    expect(turn.images.some((image) => image.name === other.name)).toBe(false);
  });

  test('the same image in current message and quote is loaded and sent only once', async () => {
    const png = file('deduplicated.png', new Uint8Array([1,2,3,4]));
    const target = reply([chip(png.id,png.name)]);
    const f = fixture([line([chip(png.id,png.name)], { replyToId: target.id, replyTarget: target })], [png]);
    expect(spoken(await f.run()).images).toHaveLength(1);
    const read = f.queries.find((q) => q.sql.includes('from attachments attachment'))!;
    expect(read.values.find(Array.isArray)).toEqual([png.id]);
  });

  test('foreign tenant/thread, mismatched target ids and invalid roles never become quoted data or blob reads', async () => {
    for (const extra of [{ organizationId: 'foreign-org' }, { threadId: 'foreign-thread' }, { id: 'another-message' }, { role: 'system' }]) {
      const target = reply([chip(crypto.randomUUID(),'PRIVATE_FOREIGN.png')], extra);
      const f = fixture([line([{ type: 'text', text: 'Current request' }], { replyToId: 'source-message', replyTarget: target as RoomLine['replyTarget'] })], []);
      const turn = spoken(await f.run());
      expect(turn.input).not.toContain('PRIVATE_FOREIGN'); expect(turn.images).toHaveLength(0);
      expect(f.queries.some((q) => q.sql.includes('from attachments attachment'))).toBe(false);
    }
  });

  test('source message SQL binds the quote to both organization and thread', async () => {
    let sql = '';
    const db = ((strings: TemplateStringsArray) => { sql = [...strings].join(' '); return Promise.resolve([]); }) as unknown as Bun.SQL;
    await readRoomLinesNewestFirst(db, context);
    expect(sql).toContain('m.reply_to_id as "replyToId"');
    expect(sql).toContain('m.organization_id ='); expect(sql).toContain('m.thread_id =');
  });

  test('deleted, foreign-thread and missing blobs produce actionable gaps instead of imaginary pixels', async () => {
    for (const failure of ['deleted','foreign','missing']) {
      const png = file('unavailable.png', new Uint8Array([1,2,3,4]), 'image', failure !== 'missing');
      if (failure === 'deleted') png.deleted = true;
      if (failure === 'foreign') png.ownerThread = 'foreign-thread';
      const target = reply([chip(png.id,png.name)]);
      const turn = spoken(await fixture([line([{ type: 'text',text:'Read cited image' }], { replyToId: target.id, replyTarget: target })], [png]).run());
      expect(turn.images).toHaveLength(0); expect(turn.input).toContain('no longer available');
      expect(turn.input).toContain('ask the operator to reattach');
    }
  });

  test('current attachments have priority and combined current/quoted count is bounded', async () => {
    const current = Array.from({ length: ATTACHMENT_LIMITS.maxCount }, (_, i) => file(`current${i}.png`,new Uint8Array([1,2,3,4])));
    const quoted = file('quoted-over-count.png',new Uint8Array([1,2,3,4]));
    const target = reply([chip(quoted.id,quoted.name)]);
    const turn = spoken(await fixture([line(current.map((row) => chip(row.id,row.name)), { replyToId:target.id,replyTarget:target })], [...current,quoted]).run());
    expect(turn.images.map((image) => image.name)).toEqual(current.map((row) => row.name));
    expect(turn.input).toContain('quoted-over-count.png'); expect(turn.input).toContain('not included');
  });

  test('combined current/quoted byte budget is bounded', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => file(`large${i}.png`,new Uint8Array(ATTACHMENT_LIMITS.maxBytesEach)));
    const target = reply(rows.map((row) => chip(row.id,row.name,'image',row.bytes)));
    const turn = spoken(await fixture([line([{ type:'text',text:'Read cited proofs' }],{ replyToId:target.id,replyTarget:target })], rows).run());
    expect(turn.images).toHaveLength(3); expect(turn.images.map((image) => image.name)).toEqual(rows.slice(0,3).map((row) => row.name));
    expect(turn.input).toContain('large3.png'); expect(turn.input).toContain('not included');
  });

  test('per-file metadata and actual byte mismatches cannot send oversized or changed files', async () => {
    const oversized = file('too-large.png',new Uint8Array(ATTACHMENT_LIMITS.maxBytesEach + 1));
    const changed = file('changed-size.png',new Uint8Array([1,2,3,4])); changed.bytes = 3;
    const corrupt = file('corrupt-large-blob.png',new Uint8Array(ATTACHMENT_LIMITS.maxBytesEach * 3)); corrupt.bytes = 4;
    const valid = file('valid.png',new Uint8Array([5,6,7,8]));
    const rows = [oversized,changed,corrupt,valid];
    const target = reply(rows.map((row) => chip(row.id,row.name,'image',row.bytes)));
    const turn = spoken(await fixture([line([{ type:'text',text:'Read cited files' }],{ replyToId:target.id,replyTarget:target })], rows).run());
    expect(turn.images).toEqual([{ name:valid.name,dataUrl:'data:image/png;base64,BQYHCA==' }]);
    expect(turn.input).toContain('too-large.png'); expect(turn.input).toContain('changed-size.png'); expect(turn.input).toContain('corrupt-large-blob.png'); expect(turn.input).toContain('not included');
  });
});
