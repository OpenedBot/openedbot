import { afterEach, describe, expect, test } from "bun:test";
import { bridgeNotifications, pathOnly, startsWindowDrag, TEXT_ZOOM_FACTORS, textZoomOf, themeModeOf } from "../../../src/lib/platform/tauri-shell";

afterEach(() => {
  document.body.innerHTML = "";
  for (const name of ["data-openedbot-text-zoom", "data-theme-mode", "data-theme"]) document.documentElement.removeAttribute(name);
});

describe("tauri-shell", () => {
  test("un clic sur une notification système appelle l'onclick de la page, une seule fois", () => {
    const sent: { title: string; options: { body?: string; id: number } }[] = [];
    const plugin = Object.assign((title: string, options: { body?: string; id: number }) => void sent.push({ title, options }), {
      permission: "default" as NotificationPermission,
      requestPermission: async () => "granted" as NotificationPermission,
    });
    const win = { Notification: plugin } as unknown as Window;
    let click: (id: number) => void = () => undefined;
    bridgeNotifications(win, (listener) => {
      click = listener;
    });
    const Shell = (win as unknown as { Notification: typeof Notification }).Notification;
    expect(Shell.permission).toBe("default");
    // Ce que fait le polyfill quand il apprend la permission.
    (Shell as unknown as { permission: NotificationPermission }).permission = "granted";
    expect(Shell.permission).toBe("granted");

    const first = new Shell("Validation requise", { body: "Atlas attend", tag: "wf-1" });
    const second = new Shell("Terminé", { body: "Fini" });
    const opened: string[] = [];
    first.onclick = () => opened.push("first");
    second.onclick = () => opened.push("second");
    // Seuls le titre, le texte et l'identifiant partent vers le système.
    expect(sent.map((entry) => Object.keys(entry.options).sort())).toEqual([["body", "id"], ["body", "id"]]);
    const [firstId, secondId] = sent.map((entry) => entry.options.id);
    expect(firstId).not.toBe(secondId);

    click(secondId!);
    click(firstId!);
    click(firstId!);
    expect(opened).toEqual(["second", "first"]);
    // Une notification fermée par la page, ou inconnue (chargement précédent), n'ouvre rien.
    const third = new Shell("Encore");
    third.onclick = () => opened.push("third");
    third.close();
    click(sent[2]!.options.id);
    click(123);
    expect(opened).toEqual(["second", "first"]);
  });

  test("le zoom du texte : un des cinq facteurs, 1 sinon, rien tant que la console ne l'a pas posé", () => {
    const root = document.documentElement;
    expect(textZoomOf(root)).toBeNull();
    root.setAttribute("data-openedbot-text-zoom", String(12 / 14));
    expect(textZoomOf(root)).toBe(12 / 14);
    root.setAttribute("data-openedbot-text-zoom", "3");
    expect(textZoomOf(root)).toBe(1);
    expect(TEXT_ZOOM_FACTORS).toHaveLength(5);
  });

  test("le thème demandé, pas la couleur résolue", () => {
    const root = document.documentElement;
    expect(themeModeOf(root)).toBe("system");
    root.setAttribute("data-theme-mode", "dark");
    expect(themeModeOf(root)).toBe("dark");
    root.setAttribute("data-theme-mode", "auto");
    expect(themeModeOf(root)).toBe("system");
  });

  test("la barre du haut déplace la fenêtre, ses contrôles restent cliquables", () => {
    document.body.innerHTML = `
      <header data-titlebar-drag><span id="title">Fil</span><button id="action">Envoyer</button></header>
      <main><p id="text">Message</p><div role="dialog"><span id="in-dialog">x</span></div></main>`;
    const at = (id: string) => document.getElementById(id);
    expect(startsWindowDrag(at("title"), 30, 1200, true)).toBe(true);
    expect(startsWindowDrag(at("action"), 30, 1200, true)).toBe(false);
    // Hors des rangées déplaçables : seule la bande du haut compte (20 px, 46 px en fenêtre étroite).
    expect(startsWindowDrag(at("text"), 300, 1200, true)).toBe(false);
    expect(startsWindowDrag(at("text"), 10, 1200, true)).toBe(true);
    expect(startsWindowDrag(at("text"), 40, 600, true)).toBe(true);
    expect(startsWindowDrag(at("in-dialog"), 10, 1200, true)).toBe(false);
    // Sans barre de titre native (navigateur), rien ne bouge.
    expect(startsWindowDrag(at("title"), 30, 1200, false)).toBe(false);
  });

  test("le journal ne reçoit jamais une requête d'URL", () => {
    expect(pathOnly("http://127.0.0.1:8790/api/auth/native/token?code=secret#x")).toBe("http://127.0.0.1:8790/api/auth/native/token");
    expect(pathOnly("pas une url")).toBe("");
  });
});
