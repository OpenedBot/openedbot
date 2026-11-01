import type { MessageAuthorBot } from "@openedbot/contracts-api";
import { useAgentEditor } from "../lib/bots/agent-editor";
import { useT } from "../lib/i18n";
import { BotFace } from "./bot-face";

/**
 * La signature d'une réponse, sous la bulle : visage de 20 px et nom, ou
 * « Réflexion… » pendant que le tour écrit. Le clic ouvre l'éditeur de ce bot.
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
 * L'en-tête d'un tour : le visage et le nom du bot, puis le contenu dessous.
 *
 * Il se pose sur la PREMIÈRE entrée visible du tour, quelle qu'elle soit. Une
 * trace de recherche ou un plan s'insèrent AVANT le journal d'outils (voir leur
 * insertion dans `merged`), et seuls `tools` et `assistant` savaient porter ce
 * libellé : le tour s'ouvrait alors sur un bloc orphelin, « 3 recherches sur le
 * web » flottant au-dessus du nom du bot au lieu d'être dessous.
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
      {/* Pas de retrait : le visage, le glyphe du journal et le bord de la
          bulle partagent la même verticale gauche. */}
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
