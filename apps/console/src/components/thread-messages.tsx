import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import { segmentMentions } from "@openedbot/roster/domain/mentions";
import { useT } from "../lib/i18n";
import { stabilizeStreamingMarkdown } from "../lib/streaming-markdown";
import { useSmoothText } from "../lib/use-smooth-text";
import type { MessageAttachmentChip } from "./attachment-canvas";
import { BotFace } from "./bot-face";
import { MessageInteractionShell, type MessageCardHover } from "./message-interactions";
import { type RunTiming } from "../lib/run-timing";
import { RunTimingBadge } from "./run-timing";
import { AttachmentTile } from "./thread-attachment-tile";
import { ThreadMarkdown } from "./thread-markdown";
import { modelUnavailableMessage } from "../lib/model-unavailable";
import { useOpenSettings } from "../lib/settings-overlay";
import { providerLabel } from "./provider-icon";
import { requestProviderReconnect } from "../lib/provider-auth";

/**
 * The failure of a turn whose provider refused the bot's login
 * (`PROVIDER_AUTH_REQUIRED`). The worker no longer hands such a turn to
 * another provider: the bubble names the provider and opens Models on that
 * provider's connection dialog, where the operator reconnects it.
 */
export function ProviderAuthNotice({
  name,
  provider,
  findTargetId,
  findActive = false,
}: {
  name: string;
  provider: string;
  findTargetId: string;
  findActive?: boolean;
}) {
  const { t } = useT();
  const openSettings = useOpenSettings();
  const label = providerLabel(provider);
  return (
    <div
      role="alert"
      data-provider-auth-required={provider}
      data-thread-find-target={findTargetId}
      className={`flex max-w-[85%] flex-col items-start gap-1.5 self-start rounded-2xl rounded-bl-md bg-destructive px-3.5 py-2.5 text-sm font-medium text-white ${findActive ? "ring-2 ring-primary ring-offset-2" : ""}`}
    >
      <p>{t("threadTimeline.providerAuthRequired", { name, provider: label })}</p>
      <button
        type="button"
        onClick={() => {
          requestProviderReconnect(provider);
          openSettings("/settings/models");
        }}
        className="cursor-pointer underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-white"
      >
        {t("threadTimeline.providerAuthRequiredAction", { provider: label })}
      </button>
    </div>
  );
}

/**
 * L'échec d'un tour dont le fournisseur refuse le modèle (`MODEL_UNAVAILABLE`).
 * À la place du « HTTP 400 » brut, une phrase qui nomme le membre et le modèle,
 * et l'action qui corrige : la conversation du bot porte le sélecteur de
 * modèle. Sans `botId` (courrier legacy), le message reste, l'action manque.
 */
export function ModelUnavailableNotice({
  name,
  model,
  botId,
  findTargetId,
  findActive = false,
}: {
  name: string;
  model: string | null;
  botId: string | null;
  findTargetId: string;
  findActive?: boolean;
}) {
  const { t } = useT();
  return (
    <div
      role="alert"
      data-model-unavailable={botId ?? ""}
      data-thread-find-target={findTargetId}
      className={`flex max-w-[85%] flex-col items-start gap-1.5 self-start rounded-2xl rounded-bl-md bg-destructive px-3.5 py-2.5 text-sm font-medium text-white ${findActive ? "ring-2 ring-primary ring-offset-2" : ""}`}
    >
      <p>{modelUnavailableMessage(t, name, model)}</p>
      {botId ? (
        <Link
          to="/bot/$botId"
          params={{ botId }}
          className="underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-white"
        >
          {t("threadTimeline.modelUnavailableAction")}
        </Link>
      ) : null}
    </div>
  );
}

/** Dev seulement : la durée réelle sous la réponse (Grok Bot n'affiche rien). */
const SHOW_RUN_TIMING = import.meta.env.DEV === true;

/**
 * Un message d'assistant.
 *
 * `memo` n'est utile QUE parce que le hook de flux préserve les identités : le
 * snapshot est muté par `applyProductEventToSnapshot`, qui ne recrée que
 * l'événement qui change. Sans cela, chaque delta reparserait tout le markdown
 * du fil.
 */
export const AssistantMessage = memo(function AssistantMessage({
  text: targetText,
  attachments,
  author,
  streaming = false,
  timing = null,
  liveSince = null,
  findTargetId,
  findActive = false,
  hover,
  settled = false,
}: {
  text: string;
  attachments?: readonly MessageAttachmentChip[];
  /** L'auteur de la bulle : visage + nom, comme un message relayé d'un autre bot. */
  author?: MessageAuthorBot | null;
  /**
   * Vrai pour la bulle du run actif : sa croissance se lisse caractère par
   * caractère (`useSmoothText`) au lieu de sauter par rafales SSE de 500 ms.
   */
  streaming?: boolean;
  /** La durée réelle du run, une fois terminé : dans l'infobulle, et sous la bulle en dev. */
  timing?: RunTiming | null;
  /** ISO : création du run en cours, d'où part le compteur (dev) pendant l'écriture. */
  liveSince?: string | null;
  findTargetId: string;
  findActive?: boolean;
  hover?: MessageCardHover;
  /** Hors des derniers tours et du direct : `content-visibility: auto`. */
  settled?: boolean;
}) {
  const text = useSmoothText(targetText, streaming);
  const markdown = streaming || text !== targetText
    ? stabilizeStreamingMarkdown(text)
    : text;
  // La bulle de Grok Bot (`message`) : au plus 560 px, 80 % du fil, et
  // 82 px de marge face au bord ; rayon 18, marges 7 / 12, le voile vient de
  // `thread-theme.css`. Rien dessous, comme chez lui : les gestes sont au
  // clic droit, la durée sous la bulle en dev seulement.
  const surface = (
    <div
      data-thread-find-target={author || hover ? undefined : findTargetId}
      data-assistant-layout="bubble"
      tabIndex={-1}
      className={`w-fit max-w-[min(80%,560px,calc(100%-82px))] min-w-0 self-start rounded-[18px] px-3 py-[7px] ${findActive ? "ring-2 ring-border-focus-ring ring-offset-2" : ""}`}
    >
      {/* `wrap-anywhere` : une URL interminable (liens RSS Google News…) doit
          casser dans la réponse, jamais élargir le fil en scroll horizontal. */}
      <div className="ai-response-reveal prose prose-sm max-w-none wrap-anywhere text-[15px] leading-[22px] text-text-primary [--tw-prose-body:var(--bui-text-primary)] [--tw-prose-headings:var(--bui-text-primary)] [--tw-prose-bold:var(--bui-text-primary)] [--tw-prose-links:var(--bui-text-primary)] dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-headings:mt-4 prose-headings:mb-2 prose-h1:text-[22px] prose-h1:leading-[28px] prose-h1:tracking-[-0.012em] prose-h2:text-[17px] prose-h2:leading-6 prose-h2:tracking-[-0.008em] prose-h3:text-[15px] prose-h4:text-[15px] prose-p:my-0 prose-p:leading-[22px] prose-ul:my-0 prose-ol:my-0 prose-li:my-0.5 prose-li:leading-[22px] [&>*+*]:mt-3 [&_li:has([data-lead-title])]:mt-4 prose-li:marker:text-text-tertiary prose-pre:my-3 prose-strong:font-semibold prose-code:rounded prose-code:bg-background-tertiary-hover/60 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none [&>:first-child]:mt-0 [&>:last-child]:mb-0">
        <ThreadMarkdown streaming={streaming}>{markdown}</ThreadMarkdown>
      </div>
    </div>
  );
  const body = hover ? (
    <MessageInteractionShell
      surface="card"
      width="fill"
      actions="menu"
      messageId={hover.messageId}
      align="start"
      labels={hover.labels}
      copyText={hover.copyText ?? markdown}
      reactions={hover.reactions}
      onReply={hover.onReply}
      onReaction={hover.onReaction}
      speaker={hover.speakerFor?.("body", hover.copyText ?? markdown)}
    >
      {surface}
    </MessageInteractionShell>
  ) : surface;
  return (
    <article
      tabIndex={-1}
      data-turn-of={author?.id}
      data-thread-find-target={author || hover ? findTargetId : undefined}
      className={`group/reply flex w-full max-w-full flex-col items-start self-start text-body-regular ${settled ? "ohb-turn-contain" : ""} ${findActive ? "rounded-[var(--radius-2-5xl)] ring-2 ring-border-focus-ring ring-offset-2" : ""}`}
    >
      <div data-assistant-response="" className="flex w-full min-w-0 flex-col items-start">
        {body}
        {SHOW_RUN_TIMING && (timing || liveSince) ? (
          <div data-run-timing="" className="px-1">
            <RunTimingBadge timing={timing} liveSince={liveSince} />
          </div>
        ) : null}
      </div>
      {attachments?.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {attachments.map((attachment, index) => (
            <li key={attachment.id ?? `${attachment.name}:${index}`}>
              <AttachmentTile attachment={attachment} />
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
});

/**
 * Une carte d'équipe : les réponses consécutives de plusieurs membres d'un
 * salon. Chaque texte garde SA bulle : la rangée d'actions vit dessous, au
 * bord droit, comme une réponse seule. La synthèse ne reprend pas le bot
 * (`thread-timeline.css`). Les contributions, elles, le nomment : elles
 * s'ouvrent par défaut, et on peut les replier.
 */
export function RoomAnswerCard({
  authors,
  synthesis,
  children,
}: {
  authors: readonly MessageAuthorBot[];
  /** Mode équipe : la réponse finale, rendue en tête. */
  synthesis: React.ReactNode[] | null;
  children: React.ReactNode[];
}) {
  const { t } = useT();
  const [contributionsOpen, setContributionsOpen] = useState(true);
  const names = authors.map((author) => author.name ?? author.slug ?? t("threadTimeline.unknownBot"));
  return (
    <section
      data-room-answer=""
      aria-label={t("threadTimeline.roomAnswer", { names: names.join(", ") })}
      className="flex w-fit max-w-[min(560px,100%)] flex-col self-start"
    >
      {synthesis ? (
        <>
          <div data-room-synthesis="" className="flex min-w-0 flex-col">{synthesis}</div>
          {children.length ? (
            <details
              data-room-contributions=""
              className="mt-2 min-w-0"
              open={contributionsOpen}
              onToggle={(event) => setContributionsOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer text-body-2-medium text-text-secondary">
                {t("threadTimeline.roomContributions", { count: children.length })}
              </summary>
              <div className="mt-2 flex min-w-0 flex-col">{children}</div>
            </details>
          ) : null}
        </>
      ) : (
        <div className="flex min-w-0 flex-col">{children}</div>
      )}
    </section>
  );
}

export const UserMessage = memo(function UserMessage({
  text,
  attachments,
  steeredIntoActive = false,
  steeredIntoSettled = false,
  mentionSlugs,
  findTargetId,
  findActive = false,
  settled = false,
}: {
  text: string;
  /**
   * US-CHAT-08 : ce que le fil garde d'une pièce jointe : son identité, jamais
   * sa charge (elle est partie au runtime dans le prompt du run). Une puce
   * sans aperçu est le prix honnête de ne pas stocker les images.
   */
  attachments?: readonly MessageAttachmentChip[];
  /** Le run de repli a été absorbé par le run qui écrivait déjà. */
  steeredIntoActive?: boolean;
  /** Absorbé par un run qui a rendu depuis : rien n'est plus « en cours ». */
  steeredIntoSettled?: boolean;
  mentionSlugs: ReadonlySet<string>;
  findTargetId: string;
  findActive?: boolean;
  /** Hors des derniers tours et du direct : `content-visibility: auto`. Jamais posé sur la bulle sortante. */
  settled?: boolean;
}) {
  const { t } = useT();
  const segments = segmentMentions(text, mentionSlugs);
  return (
    // `max-w-[520px]`, la largeur de la bulle, et non `max-w-full` : un plafond en pourcentage ne
    // borne pas la largeur intrinsèque d'un élément flex. La colonne prenait alors toute la place, la
    // bulle (plafonnée à 520 px) restait calée à droite dedans, et les actions latérales du survol
    // (réagir, répondre, …) se retrouvaient loin d'elle sur un long message.
    <div
      data-thread-find-target={findTargetId}
      tabIndex={-1}
      className={`flex max-w-[520px] flex-col items-end gap-1.5 self-end ${settled ? "ohb-turn-contain" : ""} ${findActive ? "rounded-2xl ring-2 ring-primary ring-offset-2" : ""}`}
    >
      {attachments?.length ? (
        <ul className="flex flex-wrap justify-end gap-1.5">
          {/* La clé retombe sur l'index quand l'`id` manque : les pièces
              écrites avant le rangement des fichiers n'en ont pas, et une clé
              `undefined` est une liste que React ne sait plus réconcilier. */}
          {attachments.map((attachment, index) => (
            <li key={attachment.id ?? `${attachment.name}:${index}`}>
              <AttachmentTile attachment={attachment} />
            </li>
          ))}
        </ul>
      ) : null}
      {/* Une bulle vide sous les puces se lirait comme un message perdu :
          joindre sans écrire un mot n'en rend aucune. */}
      {/* Le fond et l'encre viennent de `thread-theme.css`, comme chez Grok
          Bot : la couleur du bot, ou l'encre pour un bot sans couleur.
          Plafond en pixels seuls (560, celui de Grok Bot), pas `min(560px,100%)` : ce pourcentage se
          rapporte à une colonne dimensionnée par la bulle elle-même, et
          Firefox en tirait une largeur trop courte d'un cheveu (« carbo ? »
          renvoyait le « ? » à la ligne). La colonne flex `items-end` la
          borne déjà à sa largeur. */}
      {text ? (
    <div
      data-user-bubble=""
      className="w-fit max-w-[560px] whitespace-pre-wrap break-words rounded-[18px] px-3 py-[7px] text-start text-[15px] leading-[22px]"
    >
      {segments.map((segment, index) =>
        segment.kind === "mention" ? (
          // Un accent TEXTE, jamais un aplat : la bulle porte déjà un fond.
          // Sur l'aplat (couleur du bot ou encre), la mention garde la couleur
          // du texte, soulignée et en semi-gras (`thread-theme.css`).
          <span
            key={index}
            data-mention={segment.slug}
            className="font-semibold"
          >
            {segment.raw}
          </span>
        ) : (
          segment.text
        ),
      )}
    </div>
      ) : null}
      {steeredIntoActive || steeredIntoSettled ? (
        <p className="px-1 text-xs text-muted-foreground">
          {t(steeredIntoActive ? "threadTimeline.steeredIntoActive" : "threadTimeline.steeredIntoSettled")}
        </p>
      ) : null}
    </div>
  );
});

/**
 * Un message écrit par un AUTRE bot (bot mode, hand-off), rôle `user` côté
 * serveur mais `authorBot` posé : se rend comme la bulle du bot auteur,
 * jamais comme celle de l'opérateur.
 */
export const BotInboundMessage = memo(function BotInboundMessage({
  text,
  authorBot,
  findTargetId,
  findActive = false,
  settled = false,
}: {
  text: string;
  authorBot: MessageAuthorBot;
  findTargetId: string;
  findActive?: boolean;
  /** Hors des derniers tours et du direct : `content-visibility: auto`. */
  settled?: boolean;
}) {
  const { t } = useT();
  const label = authorBot.name ?? authorBot.slug ?? t("threadTimeline.unknownBot");
  return (
    <div
      tabIndex={-1}
      className={`flex max-w-full items-start gap-2 self-start ${settled ? "ohb-turn-contain" : ""} ${findActive ? "rounded-2xl ring-2 ring-primary ring-offset-2" : ""}`}
      aria-label={t("threadTimeline.inboundFrom", { name: label })}
      data-inbound-from={authorBot.id}
      data-thread-find-target={findTargetId}
    >
      <BotFace name={label} seed={authorBot.id} face={authorBot.face} className="size-6 mt-1" />
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="rounded-2xl rounded-bl-md bg-muted/70 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere">
          {text}
        </div>
      </div>
    </div>
  );
});
