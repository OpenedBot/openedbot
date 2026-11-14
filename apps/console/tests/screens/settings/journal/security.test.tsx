import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AccountSecurityDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { CloudSecuritySettings } from "../../../../src/screens/settings/journal/security";

const realFetch = globalThis.fetch;

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const CURRENT_SESSION = {
  id: "session-current",
  kind: "web" as const,
  current: true,
  createdAt: "2026-08-20T09:00:00.000Z",
  lastSeenAt: "2026-08-31T10:00:00.000Z",
  expiresAt: "2026-09-20T09:00:00.000Z",
  revokedAt: null,
  revokedReason: null,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  ip: "203.0.113.7",
};

const OTHER_SESSION = {
  id: "session-other",
  kind: "web" as const,
  current: false,
  createdAt: "2026-08-10T09:00:00.000Z",
  lastSeenAt: "2026-08-30T08:00:00.000Z",
  expiresAt: "2026-09-10T09:00:00.000Z",
  revokedAt: null,
  revokedReason: null,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ip: "198.51.100.4",
};

const REVOKED_SESSION = {
  id: "session-revoked",
  kind: "web" as const,
  current: false,
  createdAt: "2026-08-01T09:00:00.000Z",
  lastSeenAt: "2026-08-29T08:00:00.000Z",
  expiresAt: "2026-09-01T09:00:00.000Z",
  revokedAt: "2026-08-29T09:00:00.000Z",
  revokedReason: "user_revoked",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
  ip: "203.0.113.9",
};

const SECURITY_WITH_REVOKED: AccountSecurityDto = {
  method: { email: "elodie@example.test", password: true, google: false },
  sessions: [CURRENT_SESSION, OTHER_SESSION, REVOKED_SESSION],
  mustChangePassword: false,
};

const SECURITY_WITH_PASSWORD: AccountSecurityDto = {
  method: { email: "elodie@example.test", password: true, google: false },
  sessions: [CURRENT_SESSION, OTHER_SESSION],
  mustChangePassword: false,
};

const SECURITY_SSO_ONLY: AccountSecurityDto = {
  method: { email: "elodie@example.test", password: false, google: true },
  sessions: [CURRENT_SESSION],
  mustChangePassword: false,
};

function stubFetch(
  security: AccountSecurityDto,
  options: { passwordError?: { code: string; status: number }; calls?: string[] } = {},
) {
  const calls = options.calls ?? [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = href(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.includes("/api/account/security/sessions/revoke-others")) {
      return Response.json({ revoked: 1 });
    }
    if (url.includes("/api/account/security/sessions/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/account/security/password") && method === "POST") {
      if (options.passwordError) {
        return new Response(
          JSON.stringify({ error: { code: options.passwordError.code, message: "erreur brute non traduite" } }),
          { status: options.passwordError.status, headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ revokedOtherSessions: 1 });
    }
    if (url.includes("/api/account/security")) return Response.json(security);
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function renderSecurity() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <CloudSecuritySettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/**
 * On desktop the screen is in tabs, and Radix mounts ONLY the active panel:
 * a test looking for a password field must first open its tab,
 * exactly as the user does. Radix switches on `mousedown`, not on `click`.
 */
async function openTab(name: string) {
  const tab = await screen.findByRole("tab", { name: new RegExp(name) });
  fireEvent.mouseDown(tab);
  await waitFor(() => {
    expect(tab.getAttribute("data-state")).toBe("active");
  });
  return tab;
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("CloudSecuritySettings", () => {
  test("un mot de passe temporaire ouvre l’onglet mot de passe et dit pourquoi", async () => {
    stubFetch({ ...SECURITY_WITH_PASSWORD, mustChangePassword: true });
    renderSecurity();
    await waitFor(() => {
      // The redirect brings one here without a word of explanation: the note is that
      // word. Without it, the screen would pass for a navigation failure.
      expect(screen.getByText(/mot de passe temporaire/i)).toBeTruthy();
    });
    // And the mounted tab is the one that replaces this password, not the session.
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(3);
    });
  });

  test("la session marquée current porte le badge « cette session »", async () => {
    stubFetch(SECURITY_WITH_PASSWORD);
    renderSecurity();
    await waitFor(() => {
      expect(screen.getByText("Cette session")).toBeTruthy();
    });
  });

  test("une ligne affiche l'appareil (describeUserAgent) et la date", async () => {
    stubFetch(SECURITY_WITH_PASSWORD);
    renderSecurity();
    await openTab("Appareils");
    await waitFor(() => {
      // OTHER_SESSION is an iPhone Safari: describeUserAgent returns "Safari · iPhone".
      expect(screen.getByText("Safari · iPhone")).toBeTruthy();
    });
  });

  test("une session native courante se nomme « Application de bureau openedbot », pas « Safari »", async () => {
    // The desktop app carries its WebView's User-Agent: read as-is, it would say Safari.
    const desktop = {
      ...CURRENT_SESSION,
      kind: "native" as const,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    };
    stubFetch({ ...SECURITY_WITH_PASSWORD, sessions: [desktop, OTHER_SESSION] });
    renderSecurity();
    await waitFor(() => {
      expect(screen.getByText(/^Application de bureau openedbot/)).toBeTruthy();
    });
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    expect(screen.queryByText(/^Safari · macOS/)).toBeNull();
  });

  test("les trois onglets existent et ne montent que le panneau actif", async () => {
    stubFetch(SECURITY_WITH_PASSWORD);
    renderSecurity();
    await waitFor(() => {
      expect(screen.getAllByRole("tab").length).toBe(3);
    });

    // Default tab: the session. Neither device nor password mounted.
    expect(screen.getByText("Safari · macOS")).toBeTruthy();
    expect(screen.queryByText("Safari · iPhone")).toBeNull();
    expect(document.querySelectorAll('input[type="password"]').length).toBe(0);

    await openTab("Mot de passe");
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(3);
    });
    expect(screen.queryByText("Safari · macOS")).toBeNull();
  });

  test("l'onglet Appareils porte le nombre d'autres sessions", async () => {
    stubFetch(SECURITY_WITH_PASSWORD);
    renderSecurity();
    const tab = await screen.findByRole("tab", { name: /Appareils/ });
    // A single other session in the fixture.
    expect(tab.textContent).toContain("1");
  });

  test("une session révoquée reste listée, marquée, et n'offre plus « Révoquer »", async () => {
    stubFetch(SECURITY_WITH_REVOKED);
    renderSecurity();
    await openTab("Appareils");
    await waitFor(() => {
      expect(screen.getByText("Safari · iPhone")).toBeTruthy();
    });

    // It is there, it is the account history, not a hidden device.
    expect(screen.getByText("Chrome · Windows")).toBeTruthy();
    expect(screen.getByText("Révoquée")).toBeTruthy();
    // But only one session is still revocable: the other active one.
    expect(screen.getAllByRole("button", { name: "Révoquer" }).length).toBe(1);
  });

  test("le badge de l'onglet ne compte que les sessions encore actives", async () => {
    stubFetch(SECURITY_WITH_REVOKED);
    renderSecurity();
    const tab = await screen.findByRole("tab", { name: /Appareils/ });
    // Two "other" sessions, one of them revoked: the badge says 1.
    await waitFor(() => {
      expect(tab.textContent).toBe("Appareils1");
    });
  });

  test("le tableau porte les colonnes appareil, IP, activité et statut", async () => {
    stubFetch(SECURITY_WITH_PASSWORD);
    renderSecurity();
    await openTab("Appareils");
    await waitFor(() => {
      expect(screen.getByRole("table")).toBeTruthy();
    });
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["Appareil", "Adresse IP", "Activité", "Statut", "Actions"]);
    expect(screen.getByText("198.51.100.4")).toBeTruthy();
  });

  test("la session courante est DANS le tableau, en tête, marquée, non révocable", async () => {
    stubFetch(SECURITY_WITH_REVOKED);
    renderSecurity();
    await openTab("Appareils");
    await waitFor(() => {
      expect(screen.getByRole("table")).toBeTruthy();
    });
    // CURRENT_SESSION is a macOS Safari: it is listed like the others.
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toContain("Safari · macOS");
    expect(rows[0]!.getAttribute("data-current")).toBe("");
    expect(screen.getByText("Cet appareil")).toBeTruthy();
    // And the state is SAID in the Activité column, not only by a color.
    expect(rows[0]!.textContent).toContain("Actif · vu ");
    // Three rows, but only one revocable: neither the current one, nor the revoked one.
    expect(rows.length).toBe(3);
    expect(screen.getAllByRole("button", { name: "Révoquer" }).length).toBe(1);
  });

  test("une ligne révoquée dit QUAND et POURQUOI, pas sa dernière activité", async () => {
    stubFetch(SECURITY_WITH_REVOKED);
    renderSecurity();
    await openTab("Appareils");
    await waitFor(() => {
      expect(screen.getByText("Chrome · Windows")).toBeTruthy();
    });
    // The displayed date is that of the REVOCATION, not that of the last
    // activity, that is the whole point of the change: a session cut at
    // that instant carried the time of its last request and did not move.
    // The column omits the current year (« 29 août, 09:00 ») and keeps it
    // before; the fixtures are dated, so the expectation follows the clock.
    const format = (iso: string) => {
      const date = new Date(iso);
      const options: Intl.DateTimeFormatOptions = date.getFullYear() === new Date().getFullYear()
        ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
        : { dateStyle: "medium", timeStyle: "short" };
      return new Intl.DateTimeFormat("fr-FR", options).format(date);
    };
    expect(screen.getByText(`Révoquée ${format(REVOKED_SESSION.revokedAt)} · Par vous`)).toBeTruthy();
    const revokedRow = screen.getByText("Chrome · Windows").closest("tr");
    expect(revokedRow!.textContent).not.toContain(format(REVOKED_SESSION.lastSeenAt));
  });

  test("aucune autre session : l'onglet reste, et le dit sous le tableau", async () => {
    stubFetch(SECURITY_SSO_ONLY);
    renderSecurity();
    await openTab("Appareils");
    await waitFor(() => {
      expect(
        screen.getByText("Ce compte n’est connecté que sur l’appareil que vous utilisez."),
      ).toBeTruthy();
    });
    // The account's only device stays listed: the table is never empty.
    expect(screen.getByText("Safari · macOS")).toBeTruthy();
    // The fact « vous n'êtes connecté que là » is stated, it does not hide.
    expect(screen.queryByText("Déconnecter les autres")).toBeNull();
  });

  test("method.password === false : aucun champ de mot de passe, note SSO présente", async () => {
    stubFetch(SECURITY_SSO_ONLY);
    renderSecurity();
    await waitFor(() => {
      expect(screen.getByText(SECURITY_SSO_ONLY.method.email)).toBeTruthy();
    });
    await openTab("Mot de passe");
    expect(document.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(
      screen.getByText("Ce compte se connecte uniquement avec Google : il n’y a pas de mot de passe à changer."),
    ).toBeTruthy();
  });

  test("method.password === true : 3 champs, autoComplete corrects", async () => {
    stubFetch(SECURITY_WITH_PASSWORD);
    renderSecurity();
    await openTab("Mot de passe");
    let fields: NodeListOf<HTMLInputElement> = document.querySelectorAll('input[type="password"]');
    await waitFor(() => {
      fields = document.querySelectorAll('input[type="password"]');
      expect(fields.length).toBe(3);
    });
    const autoCompletes = Array.from(fields).map((field) => field.autocomplete);
    expect(autoCompletes).toEqual(["current-password", "new-password", "new-password"]);
  });

  test("confirmation différente du nouveau mot de passe : message local, fetch pas appelé pour /password", async () => {
    const calls: string[] = [];
    stubFetch(SECURITY_WITH_PASSWORD, { calls });
    renderSecurity();
    await openTab("Mot de passe");
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(3);
    });
    const [currentField, newField, confirmField] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    );
    fireEvent.change(currentField!, { target: { value: "old-password-123" } });
    fireEvent.change(newField!, { target: { value: "Brand-New-Password-1" } });
    fireEvent.change(confirmField!, { target: { value: "does-not-match" } });

    await waitFor(() => {
      expect(screen.getByText("La confirmation ne correspond pas au nouveau mot de passe.")).toBeTruthy();
    });
    expect(calls.some((call) => call.includes("/api/account/security/password"))).toBe(false);

    const submit = document.querySelector('button[form="settings-password-form"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  test("mot de passe < 12 caractères : bouton désactivé", async () => {
    stubFetch(SECURITY_WITH_PASSWORD);
    renderSecurity();
    await openTab("Mot de passe");
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(3);
    });
    const [currentField, newField, confirmField] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    );
    fireEvent.change(currentField!, { target: { value: "old-password-123" } });
    fireEvent.change(newField!, { target: { value: "short1" } });
    fireEvent.change(confirmField!, { target: { value: "short1" } });

    const submit = document.querySelector('button[form="settings-password-form"]') as HTMLButtonElement;
    await waitFor(() => {
      expect(submit.disabled).toBe(true);
    });
  });

  test("le tableau pagine à 10 lignes et passe à la page suivante", async () => {
    const extras = Array.from({ length: 11 }, (_, index) => ({
      ...OTHER_SESSION,
      id: `session-extra-${index}`,
      lastSeenAt: `2026-08-${String(10 + index).padStart(2, "0")}T08:00:00.000Z`,
      ip: `198.51.100.${10 + index}`,
    }));
    stubFetch({
      method: { email: "elodie@example.test", password: true, google: false },
      sessions: [CURRENT_SESSION, ...extras],
      mustChangePassword: false,
    });
    renderSecurity();
    await openTab("Appareils");
    await waitFor(() => {
      expect(screen.getByRole("table")).toBeTruthy();
    });
    expect(screen.getAllByRole("row").length).toBe(11);
    expect(screen.getByText("Affichage de 1 à 10 sur 12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Suivant" }));
    await waitFor(() => {
      expect(screen.getByText("Affichage de 11 à 12 sur 12")).toBeTruthy();
    });
    expect(screen.getAllByRole("row").length).toBe(3);
  });

  test("clic « Révoquer » sur une autre session : DELETE sur le bon chemin", async () => {
    const calls: string[] = [];
    stubFetch(SECURITY_WITH_PASSWORD, { calls });
    renderSecurity();
    await openTab("Appareils");
    await waitFor(() => {
      expect(screen.getByText("Safari · iPhone")).toBeTruthy();
    });
    const revokeButtons = screen.getAllByText("Révoquer");
    fireEvent.click(revokeButtons[0]!);
    await waitFor(() => {
      expect(calls).toContain(`DELETE /api/account/security/sessions/${OTHER_SESSION.id}`);
    });
  });

  test("l'API répond PASSWORD_NOT_SET : le message traduit s'affiche, pas le brut", async () => {
    stubFetch(SECURITY_WITH_PASSWORD, { passwordError: { code: "PASSWORD_NOT_SET", status: 409 } });
    renderSecurity();
    await openTab("Mot de passe");
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(3);
    });
    const [currentField, newField, confirmField] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    );
    fireEvent.change(currentField!, { target: { value: "old-password-123" } });
    fireEvent.change(newField!, { target: { value: "Brand-New-Password-1" } });
    fireEvent.change(confirmField!, { target: { value: "Brand-New-Password-1" } });

    const submit = document.querySelector('button[form="settings-password-form"]') as HTMLButtonElement;
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText("Ce compte se connecte uniquement avec Google.")).toBeTruthy();
    });
    expect(screen.queryByText("erreur brute non traduite")).toBeNull();
  });
});
