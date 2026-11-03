import type { BotReplyLanguage } from "@openedbot/contracts-api";
import { greetingSessionKey } from "@openedbot/roster/domain/bot-greeting-session";

export { greetingSessionKey };

export function botGreetingInput(input: {
  name: string;
  role: string | null;
  mission: string | null;
  replyLanguage: BotReplyLanguage;
  /** La langue de l'interface de l'opérateur, quand le bot n'impose pas la sienne. */
  operatorLocale?: "fr" | "en" | null;
}): string {
  const languageNames = {
    en: "English",
    fr: "French",
    es: "Spanish",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    ja: "Japanese",
    tr: "Turkish",
  } as const;
  // En `auto`, la langue des instructions ne vaut rien : la persona générée
  // est en anglais, et l'accueil partait en anglais pour un opérateur
  // francophone. Celle de son interface est la seule qu'on connaisse avant
  // qu'il ait écrit.
  const languageInstruction = input.replyLanguage !== "auto"
    ? `Write in ${languageNames[input.replyLanguage]}.`
    : input.operatorLocale
      ? `Write in ${languageNames[input.operatorLocale]}, your operator's language.`
      : "Write in the language of your instructions.";
  return [
    "[openedbot first contact] Your operator just created you and has not written yet.",
    `Your name is ${input.name}. Your role is ${input.role?.trim() || "the role in your instructions"}. Your mission is ${input.mission?.trim() || "the mission in your instructions"}.`,
    "Do not call any tool. In one or two short sentences, greet them and introduce yourself using your name, role, and mission.",
    "End your reply with exactly one question that helps you start the work, in the ask_user format: a last line `@user <question>` followed by 2 to 4 lines `- <short option>`. Nothing after the options.",
    languageInstruction,
  ].join("\n");
}

/**
 * DEV-OHB-244 faisait partir l'accueil sur le profil par défaut, dans sa
 * propre session, tant que le profil du bot se clonait. L'accueil attend
 * désormais ce profil comme tout autre run (queue.ts) ; reste le cas d'un
 * accueil déjà collé à cette session (`execution_session_key`) par une version
 * précédente : une reprise ne change jamais de profil en cours de route.
 */
export function greetingRunsOnDefaultProfile(input: {
  origin: string | null;
  threadSessionId: string;
  executionSessionKey: string | null;
}): boolean {
  return input.origin === "bot_greeting"
    && input.executionSessionKey !== null
    && input.executionSessionKey === greetingSessionKey(input.threadSessionId);
}
