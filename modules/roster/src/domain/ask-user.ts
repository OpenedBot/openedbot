/**
 * ask_user : le bot pose une question à l'opérateur, avec des réponses
 * suggérées en un tap (le motif du template vstorm, porté à notre
 * architecture).
 *
 * Chez nous un run ne se met pas en pause : la gate Hermes ne transporte que
 * `once`/`deny`, jamais un texte de reprise. La question est donc un PROTOCOLE
 * TEXTE, comme le hand-off : le bot TERMINE sa réponse par `@user <question>`
 * suivie d'options `- …`, le tour se clôt normalement, l'interface rend les
 * options en boutons, et le tap envoie l'option comme message opérateur : le
 * tour suivant reprend avec tout l'historique. Aucun canal caché, aucun état
 * serveur de plus.
 */

export const ASK_USER_LIMITS = {
  /** Le protocole en promet « up to 4 » ; on en tolère 6 au parse (bots bavards). */
  maxOptions: 6,
  optionMax: 200,
} as const;

export type AskUserPrompt = {
  question: string;
  options: string[];
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * La question qui TERMINE une sortie de bot, s'il y en a une.
 *
 * Ancrée à la fin : une ligne `@user <question>` (ou `@<handle>` de
 * l'opérateur), suivie uniquement de lignes d'option `- …` / `* …`. Une
 * mention en plein milieu du texte n'est pas une question, c'est le même
 * principe d'ancrage que le hand-off (`parseMentions`, mode "bot").
 */
export function parseAskUser(
  output: string,
  operator: { username: string } | null = null,
): AskUserPrompt | null {
  return splitAskUser(output, operator).prompt;
}

/**
 * Sépare une sortie de bot de son bloc ask_user terminal : `body` est le texte
 * SANS la question ni ses options : ce que la bulle doit montrer, le panneau
 * possédant le reste. `prompt: null` → le texte n'a pas de question, `body`
 * est le texte entier.
 */
export function splitAskUser(
  output: string,
  operator: { username: string } | null = null,
): { body: string; prompt: AskUserPrompt | null } {
  const whole = { body: output, prompt: null };
  const lines = output.trimEnd().split("\n");
  const handles = operator ? [escape(operator.username), "user"] : ["user"];
  const questionPattern = new RegExp(`^@(?:${handles.join("|")})(?![A-Za-z0-9_-])[\\s:,—-]*(.*)$`, "i");
  const optionPattern = /^[-*•]\s+(.+)$/;

  // Remonter depuis la fin : d'abord les options, puis LA ligne question.
  let index = lines.length - 1;
  while (index >= 0 && !lines[index]!.trim()) index -= 1;
  const options: string[] = [];
  while (index >= 0) {
    const line = lines[index]!.trim();
    const option = optionPattern.exec(line);
    if (!option) break;
    options.unshift(option[1]!.trim().slice(0, ASK_USER_LIMITS.optionMax));
    index -= 1;
  }
  while (index >= 0 && !lines[index]!.trim()) index -= 1;
  if (index < 0) return whole;
  const question = questionPattern.exec(lines[index]!.trim());
  if (!question) return whole;
  const text = question[1]!.trim();
  if (!text) return whole;
  if (options.length > ASK_USER_LIMITS.maxOptions) return whole;
  return {
    body: lines.slice(0, index).join("\n").trimEnd(),
    prompt: { question: text, options },
  };
}

/**
 * Nettoie un APERÇU (preview de roster, dernière ligne d'une table) du
 * préfixe protocole : un `@user`/`@<handle>` en TÊTE est de la tuyauterie, la
 * question qui suit est la vraie information.
 */
export function stripHandlePrefix(text: string, operator: { username: string } | null = null): string {
  const handles = operator ? [escape(operator.username), "user"] : ["user"];
  return text.replace(new RegExp(`^\\s*@(?:${handles.join("|")})(?![A-Za-z0-9_-])[\\s:,—-]*`, "i"), "");
}

/**
 * La règle ajoutée au protocole bot-mode (DM comme salon). En anglais, comme le reste du protocole.
 *
 * Calquée sur l'app de référence 0.75.8 (fils en cache local, 2026-10-25) : sur 571 tours
 * de bot, 15 se terminent par une carte (2,6 %), 92 par une question en texte
 * simple, le reste sans question. Ses cartes précèdent une action (envoyer,
 * publier, acheter, supprimer, choisir entre variantes concrètes) ou le premier
 * contact ; une offre de suite reste une phrase. L'outil `clarify` d'Hermes dit
 * la même chose : « Prefer deciding low-stakes questions yourself ». Sans cette
 * borne, un bot qui finit chaque tour par une carte se recopie au tour suivant.
 */
export function askUserRule(handle: string): string {
  return [
    `- Work autonomously: when the task is clear, act: do not ask for permission or confirmation. Decide low-stakes choices yourself.`,
    `- One-tap question: only BEFORE acting, when the next step needs a choice the operator alone can make (confirming something that leaves this workspace or cannot be undone: sending, publishing, buying, deleting; or picking between concrete alternatives that change the result), END your reply with a line \`@${handle} <your question>\`, then 2 to 4 short answers, one per line, each starting with \`- \`, the one you recommend first. The platform shows them as one-tap replies; the operator's answer arrives as their next message.`,
    `- When the task is done, end with the result. Never end with a one-tap question about what to do next ("What next?", "Want me to go further?"). If one concrete next step is clearly useful, offer it in one plain sentence ending with a question mark, without \`@${handle}\` and without answer lines. Most replies need no question at all.`,
  ].join("\n");
}
