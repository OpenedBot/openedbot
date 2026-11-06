import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpenedbotNativeBridge } from "../../../src/lib/platform/native-bridge";
import { appUrl, clientHeaders, desktopClientId, nativeRequestInit, openInBrowser, publicConsoleOrigin, publicConsoleUrl, withClientHeaders } from "../../../src/lib/platform";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { reportClientUpdateRequired, reportingClientUpdate, resetClientUpdateRequired } from "../../../src/lib/platform/client-update";
import { ClientUpdateGate } from "../../../src/components/client-update-required";
import { useEffect } from "react";
import { I18nProvider } from "../../../src/lib/i18n";
import { request } from "../../../src/lib/api/http";
import { threadsApi } from "../../../src/lib/api/threads";
import { supportApi } from "../../../src/lib/api/support";
import { absoluteIngressUrl } from "../../../src/components/bot-webhooks-panel";
import { asDesktopBuild } from "../../support/desktop-build";

// The bridge only exists in the desktop build; the last block checks the web build.
asDesktopBuild();

const opened: string[] = [];
function bridge(version = "1.2.3"): OpenedbotNativeBridge {
  return {
    readAccessToken: async () => "token",
    refresh: async () => "token",
    openExternal: async (url) => { opened.push(url); },
    signOut: async () => undefined,
    shell: { platform: "macos", version },
  };
}

afterEach(() => {
  delete window.__OPENEDBOT_NATIVE__;
  delete window.__OPENEDBOT_PUBLIC_CONSOLE_URL__;
  window.location.href = "http://localhost/";
  opened.length = 0;
  resetClientUpdateRequired();
});

describe("origine publique de la console", () => {
  test("dans un navigateur : l'origine de la page", () => {
    window.location.href = "https://openedbot.app/o/acme";
    expect(publicConsoleOrigin()).toBe("https://openedbot.app");
    expect(publicConsoleUrl("/invite/member/abc")).toBe("https://openedbot.app/invite/member/abc");
  });

  test("dans l'app de bureau : l'URL posée par l'app l'emporte sur l'origine de la page", () => {
    window.__OPENEDBOT_NATIVE__ = bridge();
    window.__OPENEDBOT_PUBLIC_CONSOLE_URL__ = "https://console.openedbot.app/";
    expect(publicConsoleOrigin()).toBe("https://console.openedbot.app");
    expect(publicConsoleUrl("/bot/1")).toBe("https://console.openedbot.app/bot/1");
  });

  test("sans URL posée, une page servie en https n'en tient pas lieu : erreur nommée", () => {
    window.__OPENEDBOT_NATIVE__ = bridge();
    window.location.href = "https://console.openedbot.app/";
    expect(() => publicConsoleOrigin()).toThrow(/sets no public console URL/);
  });

  test("console servie localement sous Windows (http://tauri.localhost) sans URL posée : erreur nommée, jamais un lien local", () => {
    window.__OPENEDBOT_NATIVE__ = bridge();
    window.location.href = "http://tauri.localhost/";
    expect(() => publicConsoleOrigin()).toThrow(/sets no public console URL/);
  });

  test("une URL publique non web est refusée", () => {
    window.__OPENEDBOT_NATIVE__ = bridge();
    window.__OPENEDBOT_PUBLIC_CONSOLE_URL__ = "tauri://localhost";
    expect(() => publicConsoleOrigin()).toThrow(/must be http/);
  });

  test("openInBrowser ouvre la console publique depuis l'app, jamais l'origine locale", () => {
    window.__OPENEDBOT_NATIVE__ = bridge();
    window.__OPENEDBOT_PUBLIC_CONSOLE_URL__ = "https://console.openedbot.app";
    openInBrowser("/settings");
    expect(opened).toEqual(["https://console.openedbot.app/settings"]);
  });

  test("absoluteIngressUrl retombe sur l'origine publique, ou sur le chemin si l'app n'en a pas", () => {
    window.location.href = "https://openedbot.app/";
    expect(absoluteIngressUrl("/api/hooks/x")).toBe("https://openedbot.app/api/hooks/x");
    window.__OPENEDBOT_NATIVE__ = bridge();
    window.location.href = "http://localhost/";
    window.__OPENEDBOT_PUBLIC_CONSOLE_URL__ = "tauri://localhost";
    expect(absoluteIngressUrl("/api/hooks/x")).toBe("/api/hooks/x");
  });
});

describe("appUrl", () => {
  test("lit chemin, requête et ancre sans dépendre de l'origine", () => {
    const url = appUrl("/o/acme/bot/1?tab=a#m2");
    expect([url.pathname, url.search, url.hash]).toEqual(["/o/acme/bot/1", "?tab=a", "#m2"]);
  });
});

describe("en-tête client de l'app de bureau", () => {
  test("rien dans un navigateur", () => {
    expect(clientHeaders()).toEqual({});
    expect(withClientHeaders({ method: "GET" })).toEqual({ method: "GET" });
  });

  test("desktop/X.Y.Z dans l'app, sans écraser un en-tête déjà posé", () => {
    window.__OPENEDBOT_NATIVE__ = bridge("1.2.3");
    expect(desktopClientId()).toBe("desktop/1.2.3");
    expect(clientHeaders()).toEqual({ "X-OpenedBot-Client": "desktop/1.2.3" });
    const headers = new Headers(withClientHeaders({ headers: { Authorization: "Bearer t" } })?.headers);
    expect(headers.get("X-OpenedBot-Client")).toBe("desktop/1.2.3");
    expect(headers.get("Authorization")).toBe("Bearer t");
    const kept = new Headers(withClientHeaders({ headers: { "X-OpenedBot-Client": "desktop/9.9.9" } })?.headers);
    expect(kept.get("X-OpenedBot-Client")).toBe("desktop/9.9.9");
  });

  test("une requête de l'app part sans cookie (le CORS natif n'en autorise pas), une requête web est intacte", () => {
    const init: RequestInit = { credentials: "include", headers: { Accept: "text/event-stream" } };
    expect(nativeRequestInit(init)).toBe(init);
    window.__OPENEDBOT_NATIVE__ = bridge("1.2.3");
    const native = nativeRequestInit(init)!;
    expect(native.credentials).toBe("omit");
    expect(new Headers(native.headers).get("Accept")).toBe("text/event-stream");
    expect(new Headers(native.headers).get("X-OpenedBot-Client")).toBe("desktop/1.2.3");
  });

  test("une version illisible n'annonce rien plutôt qu'une valeur fausse", () => {
    window.__OPENEDBOT_NATIVE__ = bridge("dev");
    expect(desktopClientId()).toBeNull();
    expect(clientHeaders()).toEqual({});
  });
});

describe("mise à jour requise", () => {
  test("rien tant que l'API n'a pas répondu 426, puis l'écran avec les versions de la première réponse", () => {
    window.__OPENEDBOT_NATIVE__ = bridge();
    const view = render(<I18nProvider><ClientUpdateGate>{null}</ClientUpdateGate></I18nProvider>);
    expect(view.queryByRole("alertdialog")).toBeNull();
    act(() => {
      reportClientUpdateRequired({ minVersion: "1.4.0", version: "1.2.3" });
      reportClientUpdateRequired({ minVersion: "9.9.9", version: "0.0.1" });
    });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("1.2.3");
    expect(dialog.textContent).toContain("1.4.0");
    expect(dialog.textContent).not.toContain("9.9.9");
    fireEvent.click(screen.getByRole("button"));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/openedbot\.app\/(fr\/)?download$/);
    view.unmount();
  });

  test("remplace l'app : un menu ouvert est démonté et rend le pointeur, le focus va au téléchargement", () => {
    window.__OPENEDBOT_NATIVE__ = bridge();
    // Ce que fait un menu Radix ouvert : `pointer-events: none` sur body, rendu à son démontage.
    function OpenMenu() {
      useEffect(() => {
        document.body.style.pointerEvents = "none";
        return () => { document.body.style.pointerEvents = ""; };
      }, []);
      return <button type="button">menu ouvert</button>;
    }
    const view = render(<I18nProvider><ClientUpdateGate><OpenMenu /></ClientUpdateGate></I18nProvider>);
    expect(document.body.style.pointerEvents).toBe("none");
    act(() => reportClientUpdateRequired({ minVersion: "1.4.0", version: "1.2.3" }));
    expect(screen.queryByText("menu ouvert")).toBeNull();
    expect(document.body.style.pointerEvents).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("button"));
    view.unmount();
  });
});

describe("une réponse 426 de l'API", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("annonce l'app, et affiche l'écran de mise à jour", async () => {
    window.__OPENEDBOT_NATIVE__ = bridge("1.2.3");
    let sent: Headers | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response(JSON.stringify({ error: { code: "CLIENT_UPDATE_REQUIRED", message: "old", details: { minVersion: "1.4.0", version: "1.2.3" } } }), { status: 426 });
    }) as typeof fetch;
    const view = render(<I18nProvider><ClientUpdateGate>{null}</ClientUpdateGate></I18nProvider>);
    await act(async () => {
      await request("/api/auth/me", undefined, { skipOrganizationHeader: true }).catch(() => undefined);
    });
    expect(sent!.get("X-OpenedBot-Client")).toBe("desktop/1.2.3");
    expect(screen.getByRole("alertdialog").textContent).toContain("1.4.0");
    view.unmount();
  });

  for (const [name, download] of [
    ["une pièce jointe de fil", () => threadsApi.attachment("att-1")],
    ["une capture du guichet", () => supportApi.support.attachment("att-1", null)],
  ] as const) {
    test(`${name} : l'écran de mise à jour, pas une image cassée`, async () => {
      window.__OPENEDBOT_NATIVE__ = bridge("1.2.3");
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ error: { code: "CLIENT_UPDATE_REQUIRED", message: "old", details: { minVersion: "1.4.0", version: "1.2.3" } } }),
        { status: 426 },
      )) as unknown as typeof fetch;
      const view = render(<I18nProvider><ClientUpdateGate>{null}</ClientUpdateGate></I18nProvider>);
      await act(async () => { await expect(download()).rejects.toMatchObject({ code: "ATTACHMENT_UNREADABLE" }); });
      expect(screen.getByRole("alertdialog").textContent).toContain("1.4.0");
      view.unmount();
    });
  }
});

describe("un 426 sur un flux", () => {
  test("le fetch des flux signale la mise à jour requise et rend la réponse intacte", async () => {
    const view = render(<I18nProvider><ClientUpdateGate>{null}</ClientUpdateGate></I18nProvider>);
    const streamed = reportingClientUpdate(async () => new Response(
      JSON.stringify({ error: { code: "CLIENT_UPDATE_REQUIRED", message: "old", details: { minVersion: "2.0.0", version: "1.9.0" } } }),
      { status: 426 },
    ));
    let response: Response | null = null;
    await act(async () => { response = await streamed("http://api.test/api/events"); });
    expect(response!.status).toBe(426);
    expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("CLIENT_UPDATE_REQUIRED");
    expect(screen.getByRole("alertdialog").textContent).toContain("2.0.0");
    view.unmount();
  });

  test("un autre 426 ou un corps illisible ne déclenche rien", async () => {
    const view = render(<I18nProvider><ClientUpdateGate>{null}</ClientUpdateGate></I18nProvider>);
    await act(async () => {
      await reportingClientUpdate(async () => new Response("not json", { status: 426 }))("x");
      await reportingClientUpdate(async () => new Response(JSON.stringify({ error: { code: "OTHER" } }), { status: 426 }))("x");
    });
    expect(view.queryByRole("alertdialog")).toBeNull();
    view.unmount();
  });
});

describe("build web : un pont posé par la page hôte", () => {
  const realOpen = window.open;
  beforeEach(() => { delete process.env.VITE_OPENEDBOT_SHELL; });
  afterEach(() => { window.open = realOpen; });

  test("la page reste un navigateur : origine de la page, cookie, ni en-tête client ni pont", async () => {
    window.__OPENEDBOT_NATIVE__ = bridge("1.0.3");
    window.location.href = "https://openedbot.app/o/acme";
    expect(publicConsoleOrigin()).toBe("https://openedbot.app");
    expect(desktopClientId()).toBeNull();
    expect(clientHeaders()).toEqual({});
    const init: RequestInit = { credentials: "include" };
    expect(nativeRequestInit(init)).toBe(init);
    const tabs: string[] = [];
    window.open = ((url?: string | URL) => { tabs.push(String(url)); return null; }) as typeof window.open;
    openInBrowser("/settings");
    expect(tabs).toEqual(["https://openedbot.app/settings"]);
    expect(opened).toEqual([]);
  });
});
