import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { YoloConsentDto } from "@openedbot/contracts-api";
import { fr } from "@openedbot/browser-i18n/messages.fr";
import { I18nProvider } from "../../../../src/lib/i18n";
import { RuntimeYoloSoloSwitch } from "../../../../src/screens/settings/installation/cloud/cloud-yolo-solo-switch";

const realFetch = globalThis.fetch;
const text = fr.yoloSolo;

type Call = { method: string; url: string; body: unknown };

function stubApi(consent: YoloConsentDto, onPut?: (body: { soloDefault: boolean }) => Response) {
  const calls: Call[] = [];
  let current = consent;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    if (url.endsWith("/api/organization/yolo/consent") && method === "GET") return Response.json(current);
    if (url.endsWith("/api/organization/yolo/consent") && method === "PUT") {
      if (onPut) return onPut(body);
      current = { ...current, acknowledgedAt: "2026-11-02T10:00:00.000Z", soloDefault: body.soloDefault };
      return Response.json(current);
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return calls;
}

function renderSwitch() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RuntimeYoloSoloSwitch />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

const puts = (calls: Call[]) => calls.filter((call) => call.method === "PUT");

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("RuntimeYoloSoloSwitch", () => {
  test("hidden unless the API says this owner is alone in the workspace", async () => {
    const calls = stubApi({ acknowledgedAt: null, soloDefault: false, soloEligible: false });
    const queryClient = renderSwitch();
    await waitFor(() => expect(queryClient.getQueryCache().getAll()[0]?.state.status).toBe("success"));
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(screen.queryByText(text.title)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  test("the first time, turning it on asks for a confirmation; cancelling sends nothing", async () => {
    const calls = stubApi({ acknowledgedAt: null, soloDefault: false, soloEligible: true });
    renderSwitch();
    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(text.protections)).toBeTruthy();
    fireEvent.click(toggle);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(text.confirmTitle);
    fireEvent.click(screen.getByRole("button", { name: fr.common.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(puts(calls)).toEqual([]);

    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: text.confirm }));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(puts(calls).map((call) => call.body)).toEqual([{ acknowledged: true, soloDefault: true }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("already confirmed: on and off without a dialog, the switch shows what the API read back", async () => {
    const calls = stubApi({ acknowledgedAt: "2026-11-01T09:00:00.000Z", soloDefault: true, soloEligible: true });
    renderSwitch();
    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(puts(calls).map((call) => call.body)).toEqual([
      { acknowledged: true, soloDefault: false },
      { acknowledged: true, soloDefault: true },
    ]);
  });

  test("a refusal (a second member arrived meanwhile) leaves the switch as the API says", async () => {
    const calls = stubApi({ acknowledgedAt: "2026-11-01T09:00:00.000Z", soloDefault: false, soloEligible: true }, () =>
      Response.json({ error: { code: "YOLO_SOLO_NOT_ELIGIBLE", message: "x", details: { reason: "members" } } }, { status: 409 }));
    renderSwitch();
    fireEvent.click(await screen.findByRole("switch"));
    // The refusal re-reads the setting: the switch never shows the click.
    await waitFor(() => expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]));
    await waitFor(() => expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  test("an unreadable setting is said, not hidden", async () => {
    globalThis.fetch = (async () => Response.json({ error: { code: "INTERNAL" } }, { status: 500 })) as unknown as typeof fetch;
    renderSwitch();
    expect((await screen.findByRole("alert")).textContent).toBe(text.loadFailed);
  });
});
