/**
 * Bot mode: ce que chaque bot sait des autres, et comment il leur parle.
 *
 * Hermes Desktop injecte au prompt un « protocole bot » (`agent.bot_mode_protocol`)
 * qui donne au bot son identité, le roster de ses coéquipiers et la façon de
 * les joindre. Ici les fils appartiennent à openedbot, pas à Hermes : le
 * seul canal est donc la mention `@slug`, que le worker intercepte et transmet.
 * Ce module ne fait que du texte: il est pur, testé seul, et ne connaît ni la
 * base ni le runner.
 */

import { askUserRule } from "./ask-user";
export {
  operatorHandle,
  type BotIdentity,
  type OperatorIdentity,
} from "./bot-identity";
import {
  operatorHandle,
  type BotIdentity,
  type OperatorIdentity,
} from "./bot-identity";

type Named = Pick<BotIdentity, "name" | "slug" | "description">;

const label = (bot: Named) =>
  `🤖 ${bot.name} (@${bot.slug})${bot.description?.trim() ? `: ${bot.description.trim()}` : ""}`;

/**
 * Le bloc ajouté aux instructions du bot pour CHAQUE run. En anglais, comme
 * le protocole Hermes : c'est un texte système, pas une phrase pour
 * l'utilisateur.
 */
export function buildBotModeInstructions(input: {
  self: Named;
  others: Named[];
  operator: OperatorIdentity;
  /** Le toolset `memory` du profil est actif dans cette session. */
  memoryToolEnabled?: boolean;
  /** `routine_manage` est activé pour ce bot (DEV-209) : il gère ses routines. */
  routineToolEnabled?: boolean;
  /** The bot can propose its own persona and light setting changes. */
  botSettingsToolEnabled?: boolean;
  /** Le toolset `web` du profil est actif dans cette session (`web_search`, `web_extract`). */
  webToolsEnabled?: boolean;
}): string {
  const others = input.others.length
    ? ["Other bots you can reach:", ...input.others.map((bot) => `- ${label(bot)}`)]
    : ["No other bot is reachable right now."];
  return [
    "## Bot mode",
    "",
    `You are ${label(input.self)}. You are one of the bots of this workspace, all run by the same operator: ${operatorLabel(input.operator)}. Unattributed messages come from them${
      input.operator ? `; address them as ${input.operator.username}` : ""
    }.`,
    ...others,
    "",
    "Rules:",
    "- To hand a message to another bot, write `@slug <message>` at the START of a line, at the END of your reply. At most one bot per reply. Do it only when the user asks for it or when the task clearly needs that bot; otherwise answer yourself.",
    "- A bot you mention replies ONCE, synchronously: its final reply is the only thing that comes back. Never ask it for long-running or background work: ask for something it can do and report in a single reply.",
    "- A message that starts with `Message from 🤖 <name> (@<slug>):` comes from another bot and was relayed by the platform. Reply to it briefly and directly, or answer just `pass` if you have nothing to add. Never mention (@) any bot when replying to such a message.",
    askUserRule(operatorHandle(input.operator)),
    // La même règle vit déjà dans le bloc « ## Memory » (bot-memory.ts). Elle
    // est répétée ICI parce que c'est cette liste-là que le modèle suit
    // réellement : mesuré le 26-08 (gpt-5.6-luna, effort minimal),
    // la règle isolée dans son bloc était LUE (le bot savait la citer) et
    // pourtant jamais appliquée, il répondait « C'est retenu. » sans rien
    // écrire. Deux lignes de rappel valent mieux qu'une fonctionnalité qui ne
    // se déclenche pas. Ce qu'elle rappelle a changé le 07-09 : la mémoire est
    // celle du runtime, donc l'outil `memory`: une ligne `remember:` ne serait
    // plus lue par personne.
    input.memoryToolEnabled
      ? "- When the user asks you to remember, note or keep something (in any language) you MUST call your `memory` tool (`action: add`) BEFORE replying. Replying \"noted\" without that call records NOTHING and misleads them."
      : "- Memory is switched off on this profile: if the user asks you to remember something, say so plainly instead of pretending to record it. Never write a `remember:` line: nothing reads it.",
    input.botSettingsToolEnabled
      ? "- When the operator asks you to change your persona, label, reply language or finish notice, call `bot_settings_propose` with the full new value and a one-line reason. The change applies only after the operator approves the proposal card in this thread. Never claim it is done before approval."
      : "- You cannot change your own persona or settings. Tell the operator they can edit them in the agent editor (Persona / General), or enable \"self-edit proposals\" there.",
    "- Mentions (`@slug`) are the only way to reach another bot. Your own tools stay available in this run, including web_search and web_extract. Never claim you looked something up unless a tool result in this run shows it. Memory is not a source for a recipe, a current fact, or a citation.",
    "- NEVER use delegation or background tools (delegate_task, async delegation, subagents): the platform does not track them, so their results are lost. Do the work NOW, inside this run, and never promise to \"come back later\" or to follow up: no follow-up of yours can reach this conversation.",
    // OHB-105 : Nova affirmait avoir écrit `profiles/nova/cron/jobs.json`.
    // `cronjob` est refusé par contrat (runtime-contract.ts) et ce store n'est
    // pas monté dans le sandbox : rien ne se déclenchait. Les routines openedbot
    // sont le seul planificateur, réglées par l'opérateur dans le menu du bot.
    // DEV-209 : quand l'opérateur a activé `routine_manage` pour ce bot, il
    // planifie lui-même, mais par CET outil seulement (le planificateur
    // d'openedbot) ; un fichier cron reste lettre morte. La clé de run voyage dans
    // l'entrée, jamais ici : ce bloc reste identique d'un run à l'autre.
    input.routineToolEnabled
      ? "- Recurring or timed tasks: use your `routine_manage` tool (`mcp_ohb_routines_routine_manage`). It creates real routines: each one sends you its prompt at the chosen times, in this conversation. Call `list` before changing one and never guess a `job_id`. Pass the run key from the `[routine_manage run_key: …]` line at the end of the user's message. Report exactly what the tool returned (a routine may be saved paused for the user to switch on). Nothing else schedules anything: no cron, no job file, no background tool. Never claim a routine exists without a successful call."
      : "- You cannot schedule anything: there is no cron, scheduler, reminder or recurring-job tool here, and writing a cron or job file schedules nothing. When asked for a recurring or timed task, say so plainly and tell them to add it from your menu, \"Routines…\": a routine sends you the request at the times they choose, in this conversation. Never claim a schedule exists.",
    ...(input.webToolsEnabled ? [WEB_ANSWER_RULE] : []),
  ].join("\n");
}

/**
 * Comment répondre à une question sur le monde (prix, météo, actualité,
 * score). Mesuré le 25-10 (docs/reports/2026-10-25-grokbot-vs-ohb-bench.md) :
 * un bot neuf a pris `execute_code` pour un cours (porte « opaque », fil figé),
 * lu une seule page pour la météo puis demandé la permission de chercher, et
 * cité des pages d'accueil. Hermes dit déjà « Current facts → use a retrieval/
 * search tool » (agent/prompt_builder.py, `mandatory_tool_use`) et réserve
 * `execute_code` au calcul ; cette ligne ne fait que nommer la chaîne
 * `web_search` puis `web_extract`. Posée seulement si le toolset `web` est
 * actif : jamais un outil promis qui n'existe pas.
 */
export const WEB_ANSWER_RULE =
  "- For anything in the world (a price, the weather, news, a score): `web_search`, then `web_extract` on the best one or two pages, then answer. Do not ask permission to search. Name the pages you read, never a home page. Keep `execute_code` and the terminal for calculations or processing a search cannot do.";

export function withBotModeInstructions(base: string, block: string): string {
  const trimmed = base.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/**
 * Le bloc ajouté aux instructions d'un run ENTRANT de hand-off: à la place du
 * bloc « bot mode » : la cible ne relaie jamais (profondeur 1) et sa réponse
 * finale est la SEULE chose livrée au fil d'origine. Sans lui, un bot qui
 * délègue à une tâche d'arrière-plan (`delegate_task`…) et promet de
 * « revenir » clôt le courrier sur une promesse que personne ne tiendra.
 */
export function buildInboundReplyInstructions(origin: { name: string; slug: string }): string {
  return [
    "## Relayed message",
    "",
    `You are replying to a message relayed by the platform from another bot, 🤖 ${origin.name} (@${origin.slug}). Your FINAL reply is the ONLY thing delivered back to the origin conversation; this exchange then closes.`,
    "",
    "Rules:",
    "- Do the work NOW, inside this run, and put the complete result in your reply.",
    "- NEVER use delegation or background tools (delegate_task, async delegation, subagents): the platform does not track them, so their results are lost.",
    "- Never promise to \"come back later\" or to follow up: no follow-up of yours can ever reach the origin conversation. Reply once, with everything you have.",
  ].join("\n");
}

// ── Hand-off (`@mention` en DM) ──────────────────────────────────────────────

/** Les `kind` des `system.notice` d'un courrier de hand-off (worker ET API). */
export const HANDOFF_NOTICE_KIND = {
  busy: "handoff.busy",
  sent: "handoff.sent",
  delegated: "handoff.delegated",
  received: "handoff.received",
} as const;

/** « Transmis à 🤖 neo (@neo)… »: la notice qui ancre le courrier dans le fil d'origine. */
export function handoffSentNotice(target: { name: string; slug: string }): string {
  return `Transmis à 🤖 ${target.name} (@${target.slug})…`;
}

/** Miroir dans le fil par défaut de la cible: aucun échange caché. */
export function handoffReceivedNotice(origin: { name: string; slug: string }): string {
  return `Délégation reçue de 🤖 ${origin.name} (@${origin.slug}).`;
}

export function handoffFocusHref(originSlug: string, runId: string): string {
  return `/c/${originSlug}?focus=run:${runId}`;
}

/**
 * L'inverse de `handoffSentNotice` : la cible lue dans le message d'une notice
 * de hand-off. Le payload (`{message, kind, targetBotId}`) ne porte ni nom ni
 * slug: les clients qui veulent dire « En attente de 🤖 neo… » ou masquer la
 * directive du run n'ont que le message pour source. `null` quand le format ne
 * se reconnaît pas : mieux vaut un libellé générique qu'un nom deviné.
 */
export function handoffNoticeTarget(message: string): { name: string; slug: string } | null {
  const match = /🤖\s*(.+?)\s*\(@([^)\s]+)\)/u.exec(message);
  return match ? { name: match[1]!, slug: match[2]! } : null;
}

export type HandoffMention = {
  botId: string;
  slug: string;
  name: string;
  threadId: string;
  /** Ce qui sera transmis au bot cible. */
  message: string;
};

const escape = (slug: string) => slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * LA règle de reconnaissance d'une mention, partagée mot pour mot entre le
 * worker (`parseMentions`, qui déclenche le courrier) et les clients
 * (`splitHandoff`, qui masquent la directive) : toute divergence ferait
 * masquer autre chose que ce qui a été transmis, ou l'inverse.
 *
 * `mode: "user"`: `@slug` n'importe où, à une frontière de mot
 * (`a@neo.tech` n'en est pas une), la PREMIÈRE. `mode: "bot"`: la mention doit
 * OUVRIR une ligne (le protocole l'exige, et ça évite de réagir à une phrase
 * qui PARLE d'un bot), et c'est la DERNIÈRE qui compte : la directive est
 * terminale, tout ce qui la précède est le résultat partiel. `end` pointe juste
 * après le token: c'est là que commence le message transmis en mode "bot".
 */
function matchMention(
  text: string,
  slugs: readonly string[],
  mode: "user" | "bot",
): { slug: string; index: number; end: number } | null {
  if (!slugs.length) return null;
  // Le plus long d'abord : `@neo-2` ne doit pas être lu comme `@neo` + `-2`.
  const alternatives = [...slugs]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|");
  if (mode === "user") {
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])@(${alternatives})(?![A-Za-z0-9_-])`, "i");
    const match = pattern.exec(text);
    if (!match || match.index === undefined) return null;
    return { slug: match[1]!.toLowerCase(), index: match.index, end: match.index + match[0].length };
  }
  // La DERNIÈRE directive ouvrant une ligne, pas la première : le protocole la
  // veut terminale et un modèle qui la répète en tête de réponse est courant.
  // Prendre la première vidait alors le corps: le travail déjà fait était
  // perdu, et un refus de délégation finissait en workflow échoué sans réponse
  // (mesuré le 25-08, autonomie coupée).
  const pattern = new RegExp(`^@(${alternatives})(?![A-Za-z0-9_-])`, "img");
  let last: RegExpExecArray | null = null;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) last = match;
  if (!last || last.index === undefined) return null;
  return { slug: last[1]!.toLowerCase(), index: last.index, end: last.index + last[0].length };
}

/**
 * La première mention d'un bot joignable dans un texte.
 *
 * `mode: "user"`: le texte vient de l'opérateur : `@slug` n'importe où, à
 * une frontière de mot (`a@neo.tech` n'en est pas une), et le message transmis
 * est le texte entier.
 *
 * `mode: "bot"`: le texte est la sortie d'un bot : la mention doit ouvrir une
 * ligne (le protocole l'exige, et ça évite de transmettre une phrase qui
 * PARLE d'un bot), et le message est ce qui suit le token sur la même ligne et
 * les suivantes. Vide → pas de hand-off.
 *
 * Une seule mention par message: la première en mode "user", la dernière
 * directive de ligne en mode "bot" ; le bot lui-même n'est jamais une cible.
 */
export function parseMentions(
  text: string,
  roster: readonly BotIdentity[],
  options: { selfBotId: string; mode: "user" | "bot"; includeSelf?: boolean },
): HandoffMention | null {
  const candidates = roster.filter((bot) => (options.includeSelf || bot.id !== options.selfBotId) && bot.slug);
  const match = matchMention(
    text,
    candidates.map((bot) => bot.slug),
    options.mode,
  );
  if (!match) return null;
  const bot = candidates.find((candidate) => candidate.slug.toLowerCase() === match.slug);
  if (!bot) return null;
  const message = options.mode === "user" ? text.trim() : text.slice(match.end).trim();
  if (!message) return null;
  return { botId: bot.id, slug: bot.slug, name: bot.name, threadId: bot.threadId, message };
}

/** Ce que les clients savent d'un bot joignable: la forme du roster de `parseMentions`, sans le reste. */
export type HandoffMentionable = { slug: string; name: string };

export type HandoffSplit = {
  body: string;
  handoff: { slug: string; name: string; message: string } | null;
};

/**
 * Sépare la sortie d'un bot de sa directive de hand-off terminale : `body` est
 * la prose SANS la ligne `@slug …`: ce que la bulle doit montrer :, `handoff`
 * porte la cible et le message transmis. Même précédent que `splitAskUser`
 * (ask-user.ts), même regex que `parseMentions` mode "bot" (`matchMention`) :
 * si le worker transmet, le client masque, et réciproquement.
 *
 * `handoff: null` → le texte n'a pas de directive, `body` est le texte entier.
 */
export function splitHandoff(
  text: string,
  mentionables: readonly HandoffMentionable[],
): HandoffSplit {
  const whole: HandoffSplit = { body: text, handoff: null };
  const candidates = mentionables.filter((bot) => bot.slug);
  const match = matchMention(
    text,
    candidates.map((bot) => bot.slug),
    "bot",
  );
  if (!match) return whole;
  const bot = candidates.find((candidate) => candidate.slug.toLowerCase() === match.slug);
  if (!bot) return whole;
  const message = text.slice(match.end).trim();
  if (!message) return whole;
  return {
    body: text.slice(0, match.index).trimEnd(),
    handoff: { slug: bot.slug, name: bot.name, message },
  };
}

/**
 * Le `kind` de la notice écrite quand la plateforme REFUSE la directive
 * (`advanceWorkflowCompletionTx`, worker) : autonomie coupée, boucle dans la
 * chaîne d'appels, profondeur, étapes, transmissions, jetons ou deadline. Rien
 * n'est transmis, mais l'utilisateur a lu POURQUOI: c'est ce qui distingue ce
 * refus d'une mention simplement ignorée.
 */
export const DELEGATION_REFUSED_NOTICE_KIND = "workflow.delegation_refused";

/** Ce qu'une notice dit de la directive terminale d'un run. */
export type HandoffDirectiveOutcome = "relayed" | "refused";

export type HandoffDirectiveNotice = {
  outcome: HandoffDirectiveOutcome;
  childRunId?: string;
  /**
   * La cible lue dans le message de la notice: secours quand le roster du
   * client ignore le bot (archivé depuis, appelant sans roster). `null` quand
   * le message ne la nomme pas : un refus dit la RAISON, jamais la cible.
   */
  target: HandoffMentionable | null;
};

/** L'événement minimal que lit `handoffDirectiveNotices`: `StoredProductEvent` s'y conforme. */
export type HandoffNoticeEvent = {
  runId: string;
  type: string;
  payload: Record<string, unknown>;
};

/**
 * LA règle de masquage de la directive `@slug …`, partagée mot pour mot par
 * les clients (web `thread-timeline.tsx`, client natif): même
 * exigence que `matchMention` : toute divergence ferait masquer autre chose
 * que ce que la plateforme a fait, ou l'inverse.
 *
 * La directive est de la tuyauterie de protocole ; on ne la masque QUE si une
 * notice l'explique dans le fil: transmise (`handoff.sent`) ou refusée
 * (`workflow.delegation_refused`). Sinon elle reste visible telle quelle :
 * une cible occupée (`handoff.busy`, message perdu) ou une mention de salon
 * (qui donne la parole sans rien transmettre) laissent l'utilisateur lire ce
 * que le bot a demandé. Ce garde-fou est voulu : on ne masque jamais ce
 * qu'aucune notice n'explique.
 *
 * Le retour est indexé par `runId`. Une entrée présente = directive à masquer.
 *
 * La notice de transmission vit sur le run COURRIER (bot nul), pas sur le run
 * du bot d'origine dont la bulle porte la directive ; celle de refus vit sur
 * le run d'origine lui-même. Le worker les écrit dans la même transaction que
 * le `run.completed` du run d'origine : on rattache donc la notice au dernier
 * run assistant, mais seulement si l'événement qui la précède lui appartient :
 * un courrier opérateur (mention tapée par l'humain) ne masque ainsi jamais
 * une vieille bulle dont la mention n'a rien transmis.
 */
export function handoffDirectiveNotices(
  events: readonly HandoffNoticeEvent[],
): Map<string, HandoffDirectiveNotice> {
  const byRun = new Map<string, HandoffDirectiveNotice>();
  let lastAssistantRunId: string | null = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "agent.message") lastAssistantRunId = event.runId;
    if (event.type !== "system.notice") continue;
    const kind = event.payload.kind;
    const outcome: HandoffDirectiveOutcome | null =
      kind === HANDOFF_NOTICE_KIND.sent
        ? "relayed"
        : kind === DELEGATION_REFUSED_NOTICE_KIND
          ? "refused"
          : null;
    if (!outcome) continue;
    // Les notices portent leur texte dans `message` ; `text` est la clé des
    // événements de flux: les deux sont lues, comme côté clients.
    const raw = event.payload.message ?? event.payload.text;
    const notice: HandoffDirectiveNotice = {
      outcome,
      target: typeof event.payload.targetSlug === "string" && typeof event.payload.targetName === "string"
        ? { slug: event.payload.targetSlug, name: event.payload.targetName }
        : typeof raw === "string" ? handoffNoticeTarget(raw) : null,
      ...(typeof event.payload.childRunId === "string" ? { childRunId: event.payload.childRunId } : {}),
    };
    byRun.set(event.runId, notice);
    if (lastAssistantRunId && events[i - 1]?.runId === lastAssistantRunId) {
      byRun.set(lastAssistantRunId, notice);
    }
  }
  return byRun;
}

/** Le préfixe d'attribution d'un message relayé, tel que l'autre bot le lit. */
export function attributedInput(origin: Pick<BotIdentity, "name" | "slug">, text: string): string {
  return `Message from 🤖 ${origin.name} (@${origin.slug}): ${text}`;
}

// ── Groupes (Hermes « Groups and group chats ») ──────────────────────────────

/** `👤 elodie (@elodie)`: pendant of `label()` for the operator; `👤 operator (@user)` without a profile. */
const operatorLabel = (operator: OperatorIdentity) =>
  operator ? `👤 ${operator.username} (@${operator.username})` : "👤 operator (@user)";

/** Le préfixe d'attribution de l'opérateur dans un salon : le bot doit le distinguer d'un membre. */
export function operatorAttributedInput(operator: OperatorIdentity, text: string): string {
  return `Message from ${operatorLabel(operator)}: ${text}`;
}

/**
 * Le silence choisi : `pass` ou la forme canonique Hermes `(pass)`, seuls,
 * ponctuation et casse indifférentes. Tolérer aussi « Pass. » ou « *pass* »
 * évite qu'une variation typographique n'inonde le salon.
 */
export function isPass(output: string): boolean {
  return /^[\s*_`"'«»]*(?:\(\s*pass\s*\)|pass)[\s*_`"'«».!]*$/i.test(output.trim());
}

/** Les membres qu'un texte mentionne (`@slug`, frontière de mot), dans l'ordre du roster du groupe. */
export function mentionedMembers<T extends { id: string; slug: string }>(
  text: string,
  members: readonly T[],
  options: { excludeBotId?: string } = {},
): T[] {
  return members.filter((member) => {
    if (member.id === options.excludeBotId) return false;
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])@${escape(member.slug)}(?![A-Za-z0-9_-])`, "i");
    return pattern.test(text);
  });
}

/**
 * Mentions qui ouvrent le message (`@neo @scout hello`). Une mention plus loin
 * (`hello @neo`) n'adresse personne : seul un `@` en tête réveille (OpenBot).
 * L'ordre rendu est celui du roster.
 */
export function leadingMentions<T extends { id: string; slug: string }>(
  text: string,
  members: readonly T[],
): T[] {
  let rest = text.trimStart();
  const seen = new Set<string>();
  while (rest.startsWith("@")) {
    const match = [...members]
      .filter((member) => member.slug && !seen.has(member.id))
      .sort((left, right) => right.slug.length - left.slug.length)
      .find((member) => {
        if (!rest.slice(1).toLowerCase().startsWith(member.slug.toLowerCase())) return false;
        const after = rest[1 + member.slug.length];
        return after === undefined || !/[A-Za-z0-9_-]/.test(after);
      });
    if (!match) break;
    seen.add(match.id);
    rest = rest.slice(1 + match.slug.length).trimStart();
  }
  return members.filter((member) => seen.has(member.id));
}

/** `@elodie` (ou l'alias `@user`) : le bot escalade une décision à l'opérateur. */
export function mentionsUser(text: string, operator: OperatorIdentity = null): boolean {
  const handles = operator ? [escape(operator.username), "user"] : ["user"];
  return new RegExp(`(?:^|[^A-Za-z0-9_])@(?:${handles.join("|")})(?![A-Za-z0-9_-])`, "i").test(text);
}

/** Les plafonds Hermes : « 10 messages per send, 3 rounds keep rooms from spinning ». */
export const ROOM_LIMITS = { maxRounds: 3, maxMessagesPerSend: 10, maxMemberTurns: 18 } as const;

/**
 * Relance d'un membre adressé qui a répondu `(pass)` au premier tour : texte
 * de `GROUP_ADDRESSED_NUDGE_SUFFIX` (hermes-agent `group-round-prompt.ts`,
 * #129443). Le moteur, pas la formulation, tient l'invariant : un second pass
 * est accepté.
 */
export const GROUP_ADDRESSED_NUDGE = [
  "You just replied \"(pass)\", but the operator explicitly addressed YOU in this turn.",
  "A direct address cannot be passed on. Reply now with ONE message: your answer, your result, or an explicit statement that you cannot answer and why.",
].join("\n");

export const ROOM_NOTICE_KIND = { pass: "group.pass", settled: "group.settled" } as const;

/**
 * Le bloc ajouté aux instructions d'un membre pour un tour de salon: à la
 * place du bloc hand-off, dont les règles (« @slug transmet ») ne valent pas
 * ici : dans un salon, une mention donne la parole, elle ne transmet rien.
 */
export function buildGroupInstructions(input: {
  self: Named;
  group: { name: string; instructions?: string };
  members: Named[];
  operator: OperatorIdentity;
  maxRounds: number;
  /**
   * Premier tour d'un envoi : le membre fait partie des répondants que
   * l'opérateur vient d'adresser, il répond donc toujours (comme OpenBot,
   * « Answer only your own part ») ; `(pass)` ne vaut qu'aux tours suivants.
   */
  addressed?: boolean;
  /** Le toolset `web` du profil est actif dans cette session. */
  webToolsEnabled?: boolean;
  /** Salon en mode équipe : ce tour écrit la réponse finale de l'équipe. */
  synthesis?: boolean;
  /** Contribution d'équipe : le texte ne sera pas la réponse publiée. */
  contributing?: boolean;
}): string {
  const others = input.members.filter((member) => member.slug !== input.self.slug);
  const handle = `@${operatorHandle(input.operator)}`;
  const sharedInstructions = input.group.instructions?.trim();
  return [
    `## Group chat: ${input.group.name}`,
    "",
    `You are ${label(input.self)}, a member of the group "${input.group.name}"${
      others.length ? ` together with ${others.map(label).join(", ")}` : ""
    }. The operator, ${operatorLabel(input.operator)}, is in the room too.`,
    "",
    ...(sharedInstructions ? ["Shared room instructions:", sharedInstructions, ""] : []),
    "Rules:",
    `- Every message you receive is attributed: \`Message from 🤖 <name> (@<slug>):\` for a member, \`Message from ${operatorLabel(input.operator)}:\` for the operator. Reply to the room, not to one person.`,
    input.synthesis
      ? "- This room answers as a team. Your teammates' contributions to the operator's last message are in this conversation. Write now the team's ONE final answer to the operator: merge what is useful from every contribution, yours included, drop repetition, and state a real disagreement in one line if there is one. Do not list who said what, do not greet the team, do not mention anyone, and do not answer `(pass)`."
      : input.contributing
      ? "- You are contributing to the room owner, not answering the operator yourself. Reply with only your part, a few sentences at most. If you have nothing to add, answer exactly `(pass)`. Do not greet and do not mention anyone."
      : input.addressed
      ? "- You own this turn. Answer the operator yourself. If the question is a fact, a recipe, a comparison, or asks for a source, look it up with your tools before answering, and put the URLs you actually opened in the message. A greeting or a one-word reply stays short. Do not answer `(pass)` on this turn."
      : "- Speak only when you have something new to add: reply briefly (a few sentences at most). Otherwise answer exactly `(pass)` (nothing else) to stay silent. Passing is normal and expected; never repeat what was already said.",
    `- Mention \`@slug\` when you want a specific member to weigh in. Mention \`${handle}\` only to escalate a real judgment call to the operator${
      input.operator ? " (`@user` reaches them too, but prefer their name)" : ""
    }. When you escalate, you may END your reply with \`${handle} <your question>\` followed by up to 4 suggested answers, one per line, each starting with \`- \`: the platform shows them as one-tap replies.`,
    `- Each member answers an operator message once. Only a member you mention as \`@slug\` gets another turn (up to ${input.maxRounds} rounds in total); when no one is mentioned, the room settles.`,
    "- Mentions (`@slug`) are the only way to reach another bot. Your own tools stay available in this run, including web_search and web_extract. Never claim you looked something up unless a tool result in this run shows it. Memory is not a source for a recipe, a current fact, or a citation.",
    ...(input.webToolsEnabled && !input.synthesis ? [WEB_ANSWER_RULE] : []),
  ].join("\n");
}

/**
 * Session de routage, sans persona et sans outils. Une seule clé JSON.
 * Jamais « tout le monde ».
 */
export function buildGroupRouteInstructions(members: readonly { name: string; slug: string }[]): string {
  const roster = members.map((member) => `${member.name} (@${member.slug})`).join(", ");
  return [
    "You route this room. You do not answer the operator. You have no tools. Do not call any tool.",
    "Never select all members.",
    "Reply with one JSON object and nothing else, exactly one of:",
    '{"agentId":"<slug>"} to give the turn to one member',
    '{"question":"<one short question>"} if you must ask the operator who should answer',
    '{"idle":true} if nobody should speak',
    `Members: ${roster}`,
  ].join("\n");
}
