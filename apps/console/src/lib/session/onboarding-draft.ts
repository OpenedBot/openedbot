/**
 * The LOCAL draft of the welcome flow, and nothing else.
 *
 * The cloud API remains the source of truth for what it knows: the questionnaire
 * answers, the workspace name, the handle and the exit
 * (`OnboardingStateDto`) are written along the flow and reread on mount.
 * This module keeps ONLY what the server ignores and that an F5 used to lose
 * until now: the current step, the username refused just after
 * organization creation (the page reloads between the two), and the
 * provider and model chosen at the Configuration step for as long as they are
 * not saved on the runtime.
 * It therefore never contradicts the server, it completes it.
 *
 * The draft is CARRIED BY THE active ORGANIZATION, like TanStack Query cache
 * keys: another session on the same browser does not resume someone else's
 * flow. Sign-out clears it (`sign-out.ts`), leaving the
 * flow does too (`onboarding-flow.tsx`).
 *
 * Nothing that is reread is trusted on its word: unavailable `localStorage`
 * (private browsing), a quota exceeded, broken JSON, an earlier version
 * or a step that no longer exists fall back to "no draft", therefore to
 * the start of the flow.
 */
import { type OnboardingStep } from "@/lib/session/onboarding";
import { activeOrganizationId, readCloudSession } from "./cloud-session";

export const ONBOARDING_DRAFT_KEY = "openedbot:onboarding-draft";

/** Increment as soon as the shape changes: an earlier draft is discarded, not migrated. */
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

/** The choice of the Configuration step, not yet saved on the runtime. */
export type OnboardingRuntimeDraft = {
  providerSlug: string;
  modelId: string;
};

export type OnboardingDraft = {
  step: OnboardingStep;
  /** The username to offer again when saving it failed after creation. */
  pendingUsername: string | null;
  /** Why it failed, to be said again after the reload. */
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
 * The active organization's draft, or `null` if there is none, in the broad
 * sense: unreadable, from another version, from another organization, or pointing
 * at an unknown step.
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
 * Writes a patch over the current draft. Without an active organization
 * there is nobody to attribute the draft to: nothing is written rather than
 * leaving a trace the next arrival would reread.
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
    // A draft that does not persist (quota, private browsing) must not
    // interrupt the flow: it continues in memory.
  }
}

export function clearOnboardingDraft(): void {
  try {
    globalThis.window?.localStorage.removeItem(draftStorageKey());
  } catch {
    // idem
  }
}
