import { describe, expect, test } from "bun:test";
import { t } from "@openedbot/browser-i18n";
import type { Locale, MessageKey } from "@openedbot/browser-i18n";
import { MODEL_UNAVAILABLE, readableRunFailure, runFailureExplainedInThread } from "../../src/lib/model-unavailable";
import { PROVIDER_AUTH_REQUIRED, runProviderAuthLabel, runProviderAuthSlug } from "../../src/lib/provider-auth";

// The run's stored `error` is the worker's French-only text with a raw slug:
// the toast and the composer banner must never fall back to it for this code.
const STORED_ERROR = "xai-oauth a refusé l’authentification de ce bot. Reconnectez xai-oauth dans Réglages → Modèles.";
const run = { error: STORED_ERROR, errorCode: PROVIDER_AUTH_REQUIRED };
const translate = (locale: Locale) => (key: MessageKey, params?: Record<string, string | number>) => t(locale, key, params);

describe("readableRunFailure: provider login refused", () => {
  test("names the provider in the operator's language when the run.error event is known", () => {
    expect(readableRunFailure(translate("en"), run, "Alice", "xAI")).toBe(
      "Alice can't answer: xAI refused its login. Reconnect xAI in Settings → Models.",
    );
    expect(readableRunFailure(translate("fr"), run, "Alice", "xAI")).toBe(
      "Alice ne peut pas répondre : xAI a refusé sa connexion. Reconnectez xAI dans Réglages → Modèles.",
    );
  });

  test("without the provider, a localized generic sentence, never the stored French text", () => {
    const en = readableRunFailure(translate("en"), run, "Alice", null);
    const fr = readableRunFailure(translate("fr"), run, "Alice");
    expect(en).toBe("Alice can't answer: its provider refused its login. Reconnect it in Settings → Models.");
    expect(fr).toBe("Alice ne peut pas répondre : son fournisseur a refusé sa connexion. Reconnectez-le dans Réglages → Modèles.");
    expect(en).not.toContain("xai-oauth");
  });

  test("another code still leaves the run's text to the caller", () => {
    expect(readableRunFailure(translate("en"), { ...run, errorCode: "WORKER_RUN_FAILED" }, "Alice", "xAI")).toBeNull();
  });
});

describe("runProviderAuthSlug", () => {
  const error = (runId: string, provider: unknown) => ({ runId, type: "run.error", payload: { errorCode: PROVIDER_AUTH_REQUIRED, provider } });

  test("reads the provider of the failed run's run.error event only", () => {
    const events = [error("r1", "anthropic"), { runId: "r2", type: "run.provider_fallback", payload: { to: "openrouter" } }, error("r2", "xai-oauth")];
    expect(runProviderAuthSlug(events, "r2")).toBe("xai-oauth");
    expect(runProviderAuthSlug(events, "r3")).toBeNull();
    expect(runProviderAuthSlug(undefined, "r2")).toBeNull();
  });

  test("a malformed slug is not shown", () => {
    expect(runProviderAuthSlug([error("r1", "../x")], "r1")).toBeNull();
    expect(runProviderAuthLabel([error("r1", 42)], "r1")).toBeNull();
  });

  test("the label is the provider's readable name", () => {
    expect(runProviderAuthLabel([error("r1", "anthropic")], "r1")).toBe("Anthropic");
  });
});

describe("runFailureExplainedInThread", () => {
  // REA (2026-10-24): a PROVIDER_AUTH_REQUIRED run also raised the blocking
  // "Conversation indisponible" modal, which blurred the thread and hid the
  // "Reconnecter xAI" notice behind a lone "Fermer".
  test("a refused login or model is explained in the thread, on the run or its run.error event", () => {
    expect(runFailureExplainedInThread({ id: "r1", errorCode: PROVIDER_AUTH_REQUIRED }, [])).toBe(true);
    expect(runFailureExplainedInThread({ id: "r1", errorCode: MODEL_UNAVAILABLE }, undefined)).toBe(true);
    // The run status landed before its code: the event says it.
    expect(runFailureExplainedInThread(
      { id: "r1", errorCode: null },
      [{ runId: "r1", type: "run.error", payload: { errorCode: PROVIDER_AUTH_REQUIRED, provider: "xai-oauth" } }],
    )).toBe(true);
  });

  test("any other failure still opens the modal", () => {
    expect(runFailureExplainedInThread({ id: "r1", errorCode: "HERMES_RUN_FAILED" }, [])).toBe(false);
    expect(runFailureExplainedInThread({ id: "r1" }, [
      { runId: "r2", type: "run.error", payload: { errorCode: PROVIDER_AUTH_REQUIRED } },
      { runId: "r1", type: "run.provider_fallback", payload: { errorCode: MODEL_UNAVAILABLE } },
    ])).toBe(false);
  });
});
