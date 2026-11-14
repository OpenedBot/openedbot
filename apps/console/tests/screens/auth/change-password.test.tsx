import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@openedbot/browser-ui-kit/theme";
import { I18nProvider } from "../../../src/lib/i18n";
import { ChangePasswordScreen } from "../../../src/screens/auth/change-password";

const realFetch = globalThis.fetch;

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function stubFetch(options: { error?: { code: string; status: number }; calls?: string[] } = {}) {
  const calls = options.calls ?? [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = href(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url} ${typeof init?.body === "string" ? init.body : ""}`.trim());
    if (url.includes("/api/account/security/password")) {
      if (options.error) {
        return new Response(
          JSON.stringify({ error: { code: options.error.code, message: "erreur brute non traduite" } }),
          { status: options.error.status, headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ revokedOtherSessions: 0 });
    }
    if (url.includes("/api/auth/logout")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function renderScreen(onDone: () => void = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  window.localStorage.setItem("openedbot:locale", "fr");
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <ChangePasswordScreen onDone={onDone} />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function field(label: RegExp): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

/**
 * The FIRST sign-in screen. What it must hold is not cosmetic:
 * a person who has just copied a temporary password from an
 * e-mail must be able to get in without crossing an administration screen, and without
 * discovering the shape rules through a refusal from the server.
 */
describe("écran de première connexion", () => {
  test("ne demande QUE le mot de passe, sans rien des réglages", () => {
    stubFetch();
    renderScreen();

    expect(field(/Mot de passe temporaire/)).toBeTruthy();
    expect(field(/^Nouveau mot de passe/)).toBeTruthy();
    expect(field(/Confirmez/)).toBeTruthy();
    // No piece of the security screen: no tabs, no session list,
    // no settings navigation. Three fields, and nothing else to read.
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(document.querySelectorAll("input").length).toBe(3);
    // The way out stays offered: nobody is a prisoner of this screen.
    expect(screen.getByRole("button", { name: /Se déconnecter/ })).toBeTruthy();
  });

  test("les trois règles se cochent pendant la frappe, avant tout envoi", () => {
    const calls = stubFetch();
    renderScreen();

    const next = field(/^Nouveau mot de passe/);
    fireEvent.change(next, { target: { value: "trop court" } });
    const rules = () => screen.getAllByRole("listitem").map((item) => item.getAttribute("data-ok"));
    expect(rules()).toEqual(["false", "false", "true"]);

    fireEvent.change(next, { target: { value: "Un-mot-de-passe-correct" } });
    expect(rules()).toEqual(["true", "true", "true"]);
    // Nothing went to the server to obtain this verdict.
    expect(calls).toEqual([]);
  });

  test("le bouton reste fermé tant que la saisie ne peut pas aboutir", () => {
    stubFetch();
    renderScreen();

    const submit = screen.getByRole("button", { name: /Enregistrer et entrer/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(field(/Mot de passe temporaire/), { target: { value: "Ated-aqhg-pwer-eaud" } });
    fireEvent.change(field(/^Nouveau mot de passe/), { target: { value: "Un-mot-de-passe-correct" } });
    // A different confirmation: the button does not open, and the mismatch is stated.
    fireEvent.change(field(/Confirmez/), { target: { value: "Un-mot-de-passe-different" } });
    expect(submit.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("identiques");

    fireEvent.change(field(/Confirmez/), { target: { value: "Un-mot-de-passe-correct" } });
    expect(submit.disabled).toBe(false);
  });

  test("un enregistrement réussi rend la main à l’application", async () => {
    const calls = stubFetch();
    let done = 0;
    renderScreen(() => {
      done += 1;
    });

    fireEvent.change(field(/Mot de passe temporaire/), { target: { value: "Ated-aqhg-pwer-eaud" } });
    fireEvent.change(field(/^Nouveau mot de passe/), { target: { value: "Un-mot-de-passe-correct" } });
    fireEvent.change(field(/Confirmez/), { target: { value: "Un-mot-de-passe-correct" } });
    fireEvent.click(screen.getByRole("button", { name: /Enregistrer et entrer/ }));

    await waitFor(() => {
      expect(done).toBe(1);
    });
    const posted = calls.find((call) => call.includes("/api/account/security/password"));
    expect(posted).toContain("POST");
    // The old password travels with the new one: the API requires both.
    expect(posted).toContain("Ated-aqhg-pwer-eaud");
    expect(posted).toContain("Un-mot-de-passe-correct");
  });

  test("un mot de passe temporaire refusé se dit dans la langue de l’écran", async () => {
    stubFetch({ error: { code: "CREDENTIALS_INVALID", status: 401 } });
    renderScreen();

    fireEvent.change(field(/Mot de passe temporaire/), { target: { value: "Ated-aqhg-pwer-eaud" } });
    fireEvent.change(field(/^Nouveau mot de passe/), { target: { value: "Un-mot-de-passe-correct" } });
    fireEvent.change(field(/Confirmez/), { target: { value: "Un-mot-de-passe-correct" } });
    fireEvent.click(screen.getByRole("button", { name: /Enregistrer et entrer/ }));

    const alert = await screen.findByRole("alert");
    // The API's raw message never surfaces as-is: this is the
    // most frequent case here, a character miscopied from an e-mail.
    expect(alert.textContent).toContain("Recopiez-le");
    expect(alert.textContent).not.toContain("erreur brute non traduite");
  });
});
