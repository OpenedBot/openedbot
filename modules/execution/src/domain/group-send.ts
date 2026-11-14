/**
 * L'état d'un ENVOI de salon, porté par chaque run de tour (`runs.group_state`).
 *
 * Un message de l'opérateur ouvre un envoi : jusqu'à `ROOM_LIMITS.maxRounds`
 * tours en série. `@slug` en tête (ou `@everyone`) désigne les répondants ;
 * sans adresse, le répondant par défaut les désigne, et « tout le monde » fait
 * répondre chaque membre à tour de rôle, dans l'ordre du salon, sans routeur :
 * Hermes-Bot-Mode (`plugin.js`, « mentioned members only, else everyone », « no
 * LLM router ») et l'app de référence (« multiple Bots process each message »). Au
 * premier tour, un répondant répond toujours (divergence assumée avec
 * l'amont). La phase `route` (un chef qui choisit
 * un seul membre ou pose une question) n'est plus ouverte depuis le 27/10/2026 :
 * elle laissait la question du chef, en anglais, comme seule réponse ;
 * `advanceGroupSend` sait encore finir un envoi déjà en cours. Aux tours
 * suivants, seuls ceux qu'une sortie a nommés en `@slug` reprennent. Le salon
 * se calme quand personne n'est nommé, quand un tour entier reste silencieux
 * (`pass`), ou aux plafonds.
 * L'API initialise l'état, le worker le fait avancer à chaque fin de run : les
 * deux via ce module, jamais à la main.
 */
import { ROOM_LIMITS, isPass, mentionedMembers } from "@openedbot/roster/domain/bot-mode";
import type { GroupDefaultResponder } from "@openedbot/contracts-api";

export type GroupMemberRef = { id: string; slug: string };
export type GroupMemberWithPosition = GroupMemberRef & { position: number };

export type GroupSendState = {
  /** Tour en cours, 1-indexé. */
  round: number;
  /** Messages (non-pass) déjà postés sur l'envoi entier. */
  sent: number;
  /** Membres restant à parler dans ce tour, dans l'ordre. */
  queue: string[];
  /** Membres ayant parlé (non-pass) dans ce tour. */
  spoke: string[];
  /** Membres mentionnés par les sorties de ce tour : les orateurs du tour suivant. */
  mentioned: string[];
  /**
   * Ensemble persistant des répondants depuis le dernier message opérateur.
   * Optionnel uniquement pour reprendre les états écrits avant ce champ.
   */
  responders?: string[];
  /**
   * Membres adressés relancés une fois après un `(pass)` au premier tour
   * (amont hermes-agent #129443). Optionnel pour relire les états antérieurs.
   */
  nudged?: string[];
  /**
   * `route` : session sans outils qui nomme UN propriétaire avant tout appel
   * de travail (the reference app : never select all members). `contribution` : un
   * membre délégué écrit pour le répondant, sans bulle. `synthesis` : le
   * répondant publie l'unique réponse.
   */
  phase?: "route" | "contribution" | "synthesis";
  /** Répondant qui a délégué. Il écrit la synthèse, ou rien si une seule contribution se suffit. */
  ownerId?: string;
  /** Consigne du répondant pour les contributions. Pas une bulle du fil. */
  brief?: string;
  /** Textes délégués, dans l'ordre. Une seule entrée est publiée verbatim. */
  contributions?: Array<{ botId: string; text: string }>;
};

/**
 * Plan d'ouverture d'un envoi de salon : cœur partagé entre l'API
 * (`openGroupSend`) et le tick des routines. `empty` est l'équivalent
 * métier du 409 `GROUP_EMPTY` : le caller HTTP le traduit, le worker le
 * journalise.
 */
export type RoutineGroupSendPlan =
  | { kind: "empty" }
  | { kind: "open"; botId: string; position: number; state: GroupSendState };

export function isGroupSendState(value: unknown): value is GroupSendState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    Number.isInteger(state.round) && Number(state.round) >= 1 && Number(state.round) <= ROOM_LIMITS.maxRounds &&
    Number.isInteger(state.sent) && Number(state.sent) >= 0 && Number(state.sent) <= ROOM_LIMITS.maxMessagesPerSend &&
    isDistinctStringArray(state.queue) &&
    isDistinctStringArray(state.spoke) &&
    isDistinctStringArray(state.mentioned) &&
    (state.responders === undefined || isDistinctStringArray(state.responders)) &&
    (state.nudged === undefined || isDistinctStringArray(state.nudged)) &&
    (state.phase === undefined || state.phase === "route" || state.phase === "contribution" || state.phase === "synthesis") &&
    (state.ownerId === undefined || typeof state.ownerId === "string") &&
    (state.brief === undefined || typeof state.brief === "string") &&
    (state.contributions === undefined || isContributionList(state.contributions))
  );
}

function isContributionList(value: unknown): value is Array<{ botId: string; text: string }> {
  return Array.isArray(value) && value.every((item) => (
    !!item && typeof item === "object"
    && typeof (item as { botId?: unknown }).botId === "string"
    && typeof (item as { text?: unknown }).text === "string"
  ));
}

/**
 * Mentions en tête du message opérateur, et seulement celles-là.
 * `@scout @neo hello` réveille les deux. `hello @scout` n'en réveille aucun :
 * une mention plus loin est une référence, pas une adresse (the reference app).
 * L'ordre rendu est celui du roster, pas celui du texte.
 */
function leadingAddressedMembers<T extends { id: string; slug: string }>(
  text: string,
  members: readonly T[],
): T[] {
  const bySlug = new Map(members.map((member) => [member.slug.toLowerCase(), member]));
  const found: T[] = [];
  let rest = text.trimStart();
  while (rest.startsWith("@")) {
    const match = /^@([A-Za-z0-9_-]+)/.exec(rest);
    if (!match) break;
    const member = bySlug.get(match[1]!.toLowerCase());
    if (!member || found.some((item) => item.id === member.id)) break;
    found.push(member);
    rest = rest.slice(match[0].length).trimStart();
  }
  const ids = new Set(found.map((member) => member.id));
  return members.filter((member) => ids.has(member.id));
}

export type GroupRouteDecision =
  | { kind: "agent"; botId: string }
  | { kind: "question"; text: string }
  | { kind: "idle" };

/**
 * Une seule clé. JSON illisible, `all`, ou un membre inconnu : `idle`.
 * On n'invoque jamais le roster parce que le routeur a mal répondu.
 */
export function parseGroupRouteDecision(
  output: string,
  members: readonly GroupMemberRef[],
): GroupRouteDecision {
  const text = output.trim();
  if (!text || isPass(text)) return { kind: "idle" };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { kind: "idle" };
  let body: unknown;
  try {
    body = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kind: "idle" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "idle" };
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined);
  if (record.idle === true && keys.length === 1) return { kind: "idle" };
  if (typeof record.question === "string" && record.question.trim() && keys.length === 1) {
    return { kind: "question", text: record.question.trim() };
  }
  const token = typeof record.agentId === "string"
    ? record.agentId
    : typeof record.taskId === "string"
      ? record.taskId
      : "";
  if (!token.trim() || keys.length !== 1) return { kind: "idle" };
  const normalized = token.trim().replace(/^@/, "").toLowerCase();
  if (normalized === "all" || normalized === "everyone" || normalized === "*") return { kind: "idle" };
  const member = members.find((item) => item.id === token.trim() || item.slug.toLowerCase() === normalized);
  return member ? { kind: "agent", botId: member.id } : { kind: "idle" };
}

/** Consigne du lead : une clé JSON, jamais une réponse à l'opérateur. */
export function buildGroupRouteInstructions(
  members: readonly { id: string; slug: string; name?: string | null }[],
): string {
  const lines = members.map((member) => `- ${member.name ?? member.slug} (@${member.slug}) id=${member.id}`);
  return [
    "You are the room lead. You do not answer the operator and you do not use tools.",
    "Choose exactly one member to speak, or stay silent, or ask one short question if the addressee is ambiguous.",
    "Reply with ONE JSON object and nothing else. One key only:",
    '{"agentId":"<id>"} or {"idle":true} or {"question":"<one sentence>"}',
    "Never select all members. Never return a list.",
    "Members:",
    ...lines,
  ].join("\n");
}

function isDistinctStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length;
}

/**
 * Ouvre un envoi : qui parle en premier, et l'état que porte son run.
 * `null` si le salon n'a aucun membre.
 */
export function initGroupSend(
  operatorText: string,
  members: readonly GroupMemberRef[],
  defaultResponder: GroupDefaultResponder = { kind: "everyone" },
  followUp?: GroupFollowUp,
  /**
   * Réponse à une bulle : seul ce membre reprend, sauf mention explicite
   * dans le texte. Sans ça, « reply » rouvrait tout le roster.
   */
  replyToBotId?: string | null,
  /** Mode équipe : plusieurs adresses ne deviennent pas plusieurs bouches. Un seul répondant. */
  teamMode = false,
): { botId: string; state: GroupSendState } | null {
  // `@everyone` est une cible explicite de l'app de référence : elle réveille tout le
  // roster, y compris quand le salon est configuré en `mentions`.
  const everyone = /(?:^|\s)@everyone\b/i.test(operatorText);
  // Seul un @ en tête adresse. `@everyone` reste le fan-out explicite.
  const explicit = everyone ? [...members] : leadingAddressedMembers(operatorText, members);
  const replied = !explicit.length && !everyone && replyToBotId
    ? members.filter((member) => member.id === replyToBotId)
    : [];
  const mentioned = explicit.length || everyone
    ? explicit
    : replied.length
      ? replied
      : followUpAddressees(members, followUp);
  const fallback = defaultResponder.kind === "member"
    ? members.filter((member) => member.id === defaultResponder.botId)
    : defaultResponder.kind === "mentions"
      ? []
      : [...members];
  const responders = mentioned.length ? mentioned : fallback;
  if (teamMode && responders.length > 1) {
    const owner = defaultResponder.kind === "member" && responders.some((member) => member.id === defaultResponder.botId)
      ? responders.find((member) => member.id === defaultResponder.botId)!
      : responders[0]!;
    return {
      botId: owner.id,
      state: {
        round: 1,
        sent: 0,
        queue: [],
        spoke: [],
        mentioned: [],
        responders: [owner.id],
      },
    };
  }
  // `mentions` sans cible garde un run-reçu déterministe mais n'appelle pas
  // Hermes : le premier membre est uniquement le sentinel qui matérialise le
  // silence, `responders: []` est reconnu par le worker.
  if (!responders.length && defaultResponder.kind === "mentions") {
    const sentinel = members[0];
    if (!sentinel) return null;
    return {
      botId: sentinel.id,
      state: { round: 1, sent: 0, queue: [], spoke: [], mentioned: [], responders: [] },
    };
  }
  const [first, ...rest] = responders;
  if (!first) return null;
  return {
    botId: first.id,
    state: {
      round: 1,
      sent: 0,
      queue: rest.map((member) => member.id),
      spoke: [],
      mentioned: [],
      responders: responders.map((member) => member.id),
    },
  };
}

/**
 * Le contexte d'un message sans mention : le message précédent de
 * l'opérateur dans ce salon, et le dernier membre qui a parlé.
 */
export type GroupFollowUp = { previousOperatorText: string; lastSpeakerId: string | null };

/**
 * Un message sans mention qui répond à une conversation adressée reste
 * adressé : « lille » après « @meteo quel temps demain ? » et sa question
 * de retour ne va qu'à @meteo. La conversation est en cours tant que le
 * dernier membre qui a parlé était l'un des destinataires explicites du
 * message précédent. `@everyone` dans ce message précédent ne colle pas.
 */
export function followUpAddressees(
  members: readonly GroupMemberRef[],
  followUp: GroupFollowUp | undefined,
): GroupMemberRef[] {
  if (!followUp?.lastSpeakerId) return [];
  if (/(?:^|\s)@everyone\b/i.test(followUp.previousOperatorText)) return [];
  const previous = leadingAddressedMembers(followUp.previousOperatorText, members);
  return previous.some((member) => member.id === followUp.lastSpeakerId) ? previous : [];
}

/**
 * Relit `bot_groups.default_responder` sans lever d'erreur HTTP : un JSON
 * corrompu retombe sur `everyone` pour qu'un tick de routine ne meure pas.
 */
export function coerceGroupDefaultResponder(
  value: unknown,
  memberIds: readonly string[],
): GroupDefaultResponder {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const responder = value as { kind?: unknown; botId?: unknown };
    if ((responder.kind === "everyone" || responder.kind === "mentions")
      && Object.keys(responder).length === 1) {
      return { kind: responder.kind };
    }
    if (
      responder.kind === "member"
      && typeof responder.botId === "string"
      && memberIds.includes(responder.botId)
    ) {
      return { kind: "member", botId: responder.botId };
    }
  }
  return { kind: "everyone" };
}

/** Ouvre un envoi de salon, ou `empty` s'il n'a plus de membre actif. */
export function planRoutineGroupSend(
  operatorText: string,
  members: readonly GroupMemberWithPosition[],
  defaultResponder: GroupDefaultResponder = { kind: "everyone" },
  followUp?: GroupFollowUp,
  replyToBotId?: string | null,
  teamMode = false,
): RoutineGroupSendPlan {
  const opened = initGroupSend(operatorText, members, defaultResponder, followUp, replyToBotId, teamMode);
  if (!opened) return { kind: "empty" };
  return {
    kind: "open",
    botId: opened.botId,
    position: members.find((member) => member.id === opened.botId)?.position ?? 0,
    state: opened.state,
  };
}

/**
 * Un membre adressé par l'opérateur ne peut pas passer : au premier tour, tout
 * répondant qui renvoie un `(pass)` explicite est relancé une seule fois, sur
 * le même tour (amont : `GROUP_ADDRESSED_NUDGE_SUFFIX`, hermes-agent #129443).
 * Un échec ou un silence implicite ne se relance pas ; un second pass compte.
 */
export function shouldNudgeGroupPass(state: GroupSendState, botId: string): boolean {
  // Le premier tour n'est pas un scheduler de `(pass)` : soit le membre a été
  // nommé avant l'appel, soit il n'est pas invoqué. La relance ne vaut que
  // pour un membre déjà dans un tour suivant.
  return state.round > 1
    && state.phase !== "synthesis"
    && state.phase !== "route"
    && state.phase !== "contribution"
    && Boolean(botId)
    && (state.responders ?? []).includes(botId)
    && !(state.nudged ?? []).includes(botId);
}

/** Le run en cours est-il la relance d'un membre adressé qui a passé ? */
export function isGroupNudgeTurn(state: GroupSendState, botId: string): boolean {
  return state.round > 1
    && state.phase !== "synthesis"
    && state.phase !== "route"
    && state.phase !== "contribution"
    && (state.nudged ?? []).at(-1) === botId;
}

/**
 * Qui écrit la réponse d'équipe : le répondant par défaut quand le salon en
 * nomme un et qu'il a contribué, sinon le premier membre qui a répondu.
 */
function groupSynthesisLead(
  spoke: readonly string[],
  defaultResponder: GroupDefaultResponder,
): string | null {
  if (defaultResponder.kind === "member" && spoke.includes(defaultResponder.botId)) return defaultResponder.botId;
  return spoke[0] ?? null;
}

export type GroupSendAdvance =
  | { kind: "next"; botId: string; state: GroupSendState; nudge?: true }
  | { kind: "settled" }
  | { kind: "caps"; reason: "messages" | "rounds" }
  | { kind: "question"; text: string }
  | { kind: "verbatim"; botId: string; text: string };

/**
 * Fait avancer l'envoi après le tour d'un membre. `output` est sa sortie
 * (un `pass` ne compte pas) ; un run échoué se passe en donnant `output: null`.
 * `explicitPass` distingue un `(pass)` répondu d'un échec ou d'un silence.
 */
export function advanceGroupSend(
  state: GroupSendState,
  input: {
    currentBotId: string;
    output: string | null;
    members: readonly GroupMemberRef[];
    explicitPass?: boolean;
    /** Mode équipe : après le premier tour, un membre écrit la réponse finale. */
    team?: { defaultResponder: GroupDefaultResponder };
  },
): GroupSendAdvance {
  // La synthèse clôt l'envoi : ses mentions ne rouvrent pas de tour.
  if (state.phase === "synthesis") return { kind: "settled" };
  const activeMemberIds = new Set(input.members.map((member) => member.id));
  if (state.phase === "route") {
    const decision = parseGroupRouteDecision(input.output ?? "", input.members);
    if (decision.kind === "agent" && activeMemberIds.has(decision.botId)) {
      return {
        kind: "next",
        botId: decision.botId,
        state: {
          round: 1,
          sent: 0,
          queue: [],
          spoke: [],
          mentioned: [],
          responders: [decision.botId],
        },
      };
    }
    if (decision.kind === "question") return { kind: "question", text: decision.text };
    return { kind: "settled" };
  }
  if (state.phase === "contribution") {
    const passed = input.output === null || isPass(input.output ?? "");
    const contributions = passed
      ? [...(state.contributions ?? [])]
      : [...(state.contributions ?? []), { botId: input.currentBotId, text: input.output ?? "" }];
    const [nextContributor, ...restContributors] = state.queue.filter((id) => activeMemberIds.has(id));
    if (nextContributor) {
      return {
        kind: "next",
        botId: nextContributor,
        state: { ...state, contributions, queue: restContributors, phase: "contribution" },
      };
    }
    const useful = contributions.filter((item) => item.text.trim() && activeMemberIds.has(item.botId));
    if (useful.length === 1) {
      const only = useful[0]!;
      return { kind: "verbatim", botId: only.botId, text: only.text };
    }
    if (useful.length >= 2) {
      const owner = state.ownerId && activeMemberIds.has(state.ownerId) ? state.ownerId : useful[0]!.botId;
      return {
        kind: "next",
        botId: owner,
        state: {
          ...state,
          sent: state.sent,
          spoke: useful.map((item) => item.botId),
          mentioned: [],
          queue: [],
          phase: "synthesis",
          responders: [owner],
          contributions: useful,
        },
      };
    }
    return { kind: "settled" };
  }
  if (
    input.explicitPass &&
    activeMemberIds.has(input.currentBotId) &&
    shouldNudgeGroupPass(state, input.currentBotId)
  ) {
    return {
      kind: "next",
      botId: input.currentBotId,
      nudge: true,
      state: { ...state, nudged: [...(state.nudged ?? []), input.currentBotId] },
    };
  }
  const activeQueue = state.queue.filter((id) => activeMemberIds.has(id));
  // Un état ancien n'a pas `responders`. Au premier round, le membre courant
  // et sa file persistée reconstruisent exactement la cible initiale.
  const previousResponders = (state.responders ?? [...state.spoke, input.currentBotId, ...activeQueue])
    .filter((id, index, all) => activeMemberIds.has(id) && all.indexOf(id) === index);
  const passed = input.output === null || isPass(input.output);
  const spoke = passed ? state.spoke : [...state.spoke, input.currentBotId];
  const sent = passed ? state.sent : state.sent + 1;
  const mentioned = passed
    ? state.mentioned
    : [
        ...state.mentioned,
        ...mentionedMembers(input.output ?? "", input.members, { excludeBotId: input.currentBotId })
          .map((member) => member.id)
          .filter((id) => !state.mentioned.includes(id)),
      ];
  const responderIds = input.members
    .map((member) => member.id)
    .filter((id) => previousResponders.includes(id) || mentioned.includes(id));

  if (sent >= ROOM_LIMITS.maxMessagesPerSend) return { kind: "caps", reason: "messages" };

  // Mode équipe : un @ dans la sortie délègue. Ces tours ne publient pas.
  // Le répondant intégrera, sauf si une seule contribution se suffit.
  if (input.team && !passed) {
    const delegated = mentioned.filter((id) => activeMemberIds.has(id));
    if (delegated.length > 0) {
      const [first, ...rest] = delegated;
      if (!first) return { kind: "settled" };
      return {
        kind: "next",
        botId: first,
        state: {
          round: state.round,
          sent,
          queue: rest,
          spoke: [],
          mentioned: [],
          responders: delegated,
          phase: "contribution",
          ownerId: input.currentBotId,
          brief: input.output ?? "",
          contributions: [],
        },
      };
    }
  }

  // `queue` is persisted on the previous run.  A member can be archived or
  // deleted before that run completes, so only ids still present in the
  // current active roster may receive the next run.
  const [nextInRound, ...restOfRound] = activeQueue;
  if (nextInRound) {
    return {
      kind: "next",
      botId: nextInRound,
      state: { ...state, sent, spoke, mentioned, responders: responderIds, queue: restOfRound },
    };
  }

  // Fin de tour : seuls les membres qu'une sortie du tour a nommés (`@slug`)
  // reprennent la parole, dans l'ordre où ils ont été nommés (the reference app
  // `relay`, server/src/channels/group.ts). Personne de nommé : le salon se
  // calme. Relancer tout le roster faisait réfléchir chaque bot une seconde
  // fois après chaque envoi, pour passer.
  if (!spoke.length) return { kind: "settled" };
  // File d'un fan-out salon (mode each) : pas de synthèse. En mode équipe,
  // plusieurs bouches ne se publient pas ; la délégation ci-dessus a déjà
  // bifurqué. Une seule voix déjà écrite est la réponse.
  if (input.team && state.round === 1 && spoke.length >= 2) {
    const contributors = spoke.filter((id) => activeMemberIds.has(id));
    const lead = groupSynthesisLead(contributors, input.team.defaultResponder);
    if (lead) {
      return {
        kind: "next",
        botId: lead,
        state: { ...state, sent, spoke, mentioned, responders: [lead], queue: [], phase: "synthesis" },
      };
    }
  }
  if (input.team && state.round === 1) return { kind: "settled" };
  const addressed = mentioned.filter((id) => activeMemberIds.has(id));
  const [first, ...rest] = addressed;
  if (!first) return { kind: "settled" };
  if (state.round >= ROOM_LIMITS.maxRounds) return { kind: "caps", reason: "rounds" };
  return {
    kind: "next",
    botId: first,
    state: {
      round: state.round + 1,
      sent,
      queue: rest,
      spoke: [],
      mentioned: [],
      responders: responderIds,
    },
  };
}
