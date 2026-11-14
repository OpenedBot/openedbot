import type { MessageAuthorBot } from "@openedbot/contracts-api";
import { useAgentEditor } from "../lib/bots/agent-editor";
import { useT } from "../lib/i18n";
import { BotFace } from "./bot-face";

/**
 * A reply's signature, under the bubble: a 20 px face and a name, or
 * « Réflexion… » while the turn is writing. The click opens that bot's editor.
 */
export function AssistantAuthor({ author, label, thinking = false }: { author: MessageAuthorBot; label: string; thinking?: boolean }) {
  const { t } = useT();
  const showEditor = useAgentEditor((state) => state.show);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => showEditor(author.id)}
      data-assistant-author=""
      data-thinking={thinking ? "" : undefined}
      className="my-1 flex min-w-0 items-center gap-1 rounded-lg text-start text-body-2-medium text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <BotFace name={label} seed={author.id} face={author.face} className="size-5 shrink-0" />
      <span className={`truncate ${thinking ? "bui-thinking-label" : ""}`}>{thinking ? t("boardui.thinking") : label}</span>
    </button>
  );
}

/**
 * A turn's header: the bot's face and name, then the content below.
 *
 * It sits on the FIRST visible entry of the turn, whichever it is. A
 * search trace or a plan insert BEFORE the tool log (see their
 * insertion in `merged`), and only `tools` and `assistant` knew how to carry this
 * label: the turn then opened on an orphan block, « 3 recherches sur le
 * web » floating above the bot's name instead of being below it.
 */
export function TurnAuthorHeader({ author, label, children }: {
  author: MessageAuthorBot;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      tabIndex={-1}
      className="flex w-full max-w-full flex-col items-start gap-0.5 self-start"
      data-turn-of={author.id}
    >
      {/* No indent: the face, the log's glyph and the edge of the
          bubble share the same left vertical. */}
      <div data-tool-author="" className="flex min-h-6 items-center gap-2 pr-3 text-body-2-medium text-text-secondary">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <BotFace name={label} seed={author.id} face={author.face} className="size-5 shrink-0" />
        </span>
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div data-tool-response="" className="w-full min-w-0">{children}</div>
    </div>
  );
}
