/**
 * Le brouillon LOCAL du parcours d'accueil, et rien d'autre.
 *
 * Le cloud API reste la source de vérité de ce qu'il connaît : les réponses du
 * questionnaire, le nom de l'espace, le handle et la sortie
 * (`OnboardingStateDto`) sont écrits au fil du parcours et relus au montage.
 * Ce module ne garde QUE ce que le serveur ignore et qu'un F5 perdait
 * jusqu'ici : l'étape en cours, le nom d'utilisateur refusé juste après la
 * création de l'organisation (la page se recharge entre les deux), et le
 * fournisseur et le modèle choisis à l'étape Configuration tant qu'ils ne
 * sont pas enregistrés sur le runtime.
 * Il ne contredit donc jamais le serveur, il le complète.
 *
 * Le brouillon est PORTÉ PAR L'ORGANISATION active, comme les clés de cache de
 * TanStack Query : une autre session sur le même navigateur ne reprend pas le
 * parcours d'un autre. La déconnexion l'efface (`sign-out.ts`), la sortie du
 * parcours aussi (`onboarding-flow.tsx`).
 *
 * Rien de ce qui est relu n'est cru sur parole : un `localStorage` indisponible
 * (navigation privée), un quota dépassé, un JSON cassé, une version antérieure
 * ou une étape qui n'existe plus retombent sur « pas de brouillon », donc sur
 * le début du parcours.
 */
import { type OnboardingStep } from "@/lib/session/onboarding";
import { activeOrganizationId, readCloudSession } from "./cloud-session";

export const ONBOARDING_DRAFT_KEY = "openedbot:onboarding-draft";

/** Incrémenter dès que la forme change : un brouillon d'avant est jeté, pas migré. */
const DRAFT_VERSION = 2;

function draftStorageKey(): string {
  const session = readCloudSession();
  return session?.userId && session.organizationId
    ? `${ONBOARDING_DRAFT_KEY}:${session.userId}:${session.organizationId}` : ONBOARDING_DRAFT_KEY;
}

const KNOWN_STEPS: readonly OnboardingStep[] = [
  "welcome",
  "workspace",
  "runtime",
];

/** Le choix de l'étape Configuration, pas encore enregistré sur le runtime. */
export type OnboardingRuntimeDraft = {
  providerSlug: string;
  modelId: string;
};

export type OnboardingDraft = {
  step: OnboardingStep;
  /** Le nom d'utilisateur à reproposer quand son enregistrement a échoué après la création. */
  pendingUsername: string | null;
  /** Pourquoi il a échoué, à redire après le rechargement. */
  pendingUsernameError: string | null;
  runtime: OnboardingRuntimeDraft;
};

export const EMPTY_RUNTIME_DRAFT: OnboardingRuntimeDraft = { providerSlug: "", modelId: "" };

const EMPTY_DRAFT: OnboardingDraft = {
  step: "welcome",
  pendingUsername: null,
  pendingUsernameError: null,
  runtime: EMPTY_RUNTIME_DRAFT,
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function runtimeFrom(raw: unknown): OnboardingRuntimeDraft {
  if (!raw || typeof raw !== "object") return EMPTY_RUNTIME_DRAFT;
  const value = raw as Record<string, unknown>;
  return { providerSlug: text(value.providerSlug), modelId: text(value.modelId) };
}

/**
 * Le brouillon de l'organisation active, ou `null` s'il n'y en a pas, au sens
 * large : illisible, d'une autre version, d'une autre organisation, ou pointant
 * vers une étape inconnue.
 */
export function readOnboardingDraft(): OnboardingDraft | null {
  try {
    const raw = globalThis.window?.localStorage.getItem(draftStorageKey());
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (value.version !== DRAFT_VERSION) return null;
    const organizationId = activeOrganizationId();
    if (!organizationId || value.organizationId !== organizationId) return null;
    const step = value.step;
    if (typeof step !== "string" || !KNOWN_STEPS.includes(step as OnboardingStep)) return null;
    return {
      step: step as OnboardingStep,
      pendingUsername: typeof value.pendingUsername === "string" ? value.pendingUsername : null,
      pendingUsernameError: typeof value.pendingUsernameError === "string" ? value.pendingUsernameError : null,
      runtime: runtimeFrom(value.runtime),
    };
  } catch {
    return null;
  }
}

/**
 * Écrit un correctif par-dessus le brouillon courant. Sans organisation active
 * il n'y a personne à qui attribuer le brouillon : on n'écrit rien plutôt que
 * de laisser une trace que le prochain arrivant relirait.
 */
export function writeOnboardingDraft(patch: Partial<OnboardingDraft>): void {
  const organizationId = activeOrganizationId();
  if (!organizationId) return;
  const next: OnboardingDraft = { ...(readOnboardingDraft() ?? EMPTY_DRAFT), ...patch };
  try {
    globalThis.window?.localStorage.setItem(
      draftStorageKey(),
      JSON.stringify({ version: DRAFT_VERSION, organizationId, ...next }),
    );
  } catch {
    // Un brouillon qui ne persiste pas (quota, navigation privée) ne doit pas
    // interrompre le parcours : on continue en mémoire.
  }
}

export function clearOnboardingDraft(): void {
  try {
    globalThis.window?.localStorage.removeItem(draftStorageKey());
  } catch {
    // idem
  }
}
