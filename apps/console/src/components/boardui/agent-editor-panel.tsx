import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { RosterDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { EDITOR_INLINE_QUERY, useAgentEditor } from "../../lib/bots/agent-editor";
import { InlineEditorSlot } from "./agent-editor-slot";
import type { EditorBot } from "./agent-editor";

// The editor itself (faces, cat stage, voices) mounts only once opened: it
// loads then, never in the console's first load (console bundle budget).
const AgentEditor = lazy(() => import("./agent-editor").then((module) => ({ default: module.AgentEditor })));

const INLINE_QUERY = EDITOR_INLINE_QUERY;

function subscribeInline(onChange: () => void) {
  const query = window.matchMedia(INLINE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const inlineSnapshot = () => window.matchMedia(INLINE_QUERY).matches;

function editorBotOf(roster: RosterDto, botId: string | undefined): EditorBot | null {
  const bot = roster.bots.find((candidate) => candidate.id === botId && candidate.archivedAt === null);
  if (!bot) return null;
  const {
    running: _running,
    unread: _unread,
    preview: _preview,
    lastActivityAt: _lastActivityAt,
    lastRunAt: _lastRunAt,
    awaitingApproval: _awaitingApproval,
    updatedAt: _updatedAt,
    ...editable
  } = bot;
  return editable;
}

/**
 * The BoardUI template's agent editor, to the right of the thread.
 *
 * It edits the open thread's bot (or the one « Modifier le bot » named)
 * and writes each setting at once, like the reference: appearance
 * (expression, shape, bloub face colour, or mascot), name, role,
 * description, reply language, finish notice, voice and reading speed.
 */
export function AgentEditorPanel() {
  const { botId: routeBotId } = useParams({ strict: false }) as { botId?: string };
  const open = useAgentEditor((state) => state.open);
  const pinnedBotId = useAgentEditor((state) => state.botId);
  const close = useAgentEditor((state) => state.close);
  const inline = useSyncExternalStore(subscribeInline, inlineSnapshot, () => true);
  const botId = pinnedBotId ?? routeBotId;
  const selectEditorBot = useCallback((roster: RosterDto) => editorBotOf(roster, botId), [botId]);
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, select: selectEditorBot });
  const bot = roster.data ?? null;
  // Under 1100 px, the panel covers the thread: it opens only on demand
  // (title pill, « Modifier le bot »), never on its own on arrival.
  const [overlayOpened, setOverlayOpened] = useState(false);
  useEffect(() => {
    if (inline) setOverlayOpened(false);
  }, [inline]);
  useEffect(() => useAgentEditor.subscribe((state) => {
    setOverlayOpened(state.open);
  }), []);
  const visible = Boolean(bot) && open && (inline || overlayOpened);
  // The inline editor stays mounted once opened (close transition, draft),
  // but not before: mounted closed, it cost every first paint ~50 ms.
  const [editorMounted, setEditorMounted] = useState(visible);
  if (visible && !editorMounted) setEditorMounted(true);

  if (inline) {
    return (
      <InlineEditorSlot visible={visible}>
        {bot && editorMounted ? <Suspense fallback={null}><AgentEditor key={bot.id} bot={bot} onClose={close} /></Suspense> : null}
      </InlineEditorSlot>
    );
  }
  if (!visible || !bot) return null;
  return (
    <>
      <div
        aria-hidden
        className="fixed inset-0 z-40 bg-background-full/30 backdrop-blur-[6px]"
        onClick={() => { setOverlayOpened(false); close(); }}
      />
      <div className="bui-popover fixed inset-y-0 end-2 z-50 w-[min(340px,calc(100vw-16px))]">
        <Suspense fallback={null}>
          <AgentEditor key={bot.id} bot={bot} onClose={() => { setOverlayOpened(false); close(); }} />
        </Suspense>
      </div>
    </>
  );
}
