/**
 * Preuve navigateur de l'écran /settings/runtime, sans dépendance.
 *
 * Le poste a déjà Chrome ; `scripts/link-dev-pass.sh verify` en ouvre un
 * jetable, sur son propre profil, et laisse ce fichier le piloter par le
 * protocole DevTools. Aucun paquet n'est installé pour ça, et le Chrome de
 * l'opérateur n'est ni ouvert ni touché.
 *
 * Ce que la passe prouve, et rien d'autre : le registre dit lequel de ses trois
 * silences il vit (lecture, échec, vide), l'appairage se joue DANS une boîte
 * modale et pas à plat dans la carte, la fenêtre du nom devient celle du
 * ticket sans en ouvrir une seconde, et le ticket ne fuit pas hors de la boîte.
 * Rien sur le contenu d'un run, rien sur un hôte distant.
 *
 * Un passage ouvre un vrai enrôlement sur l'API LOCALE : un ticket qui meurt
 * en cinq minutes, qu'aucune machine ne réclame. Aucun hôte n'est joint,
 * aucune instance connecteur n'est touchée.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMailpitMessageIds, readMailpitLoginCode } from "../../../scripts/lib/password-login";

const CDP_PORT = process.env.LINK_DEV_VERIFY_PORT?.trim() || "9333";
const ORIGIN = (process.env.WEB_APP_URL?.trim() || "http://localhost:1420").replace(/\/+$/u, "");
const OUT = process.env.LINK_DEV_VERIFY_OUT?.trim() || "tmp/runtime-settings-pass";
const EMAIL = process.env.LINK_DEV_EMAIL?.trim() || process.env.E2E_EMAIL?.trim() || "dev@openedbot.local";
const PASSWORD = process.env.LINK_DEV_PASSWORD || process.env.E2E_PASSWORD || (() => { throw new Error("LINK_DEV_PASSWORD / E2E_PASSWORD is not set: run `make setup` (it generates E2E_PASSWORD in .env.local)."); })();
/** Le nom du runtime de la passe : reconnaissable, et jamais celui d'un vrai. */
const DRAFT_NAME = "Vérification appairage";

mkdirSync(OUT, { recursive: true });

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} : ${detail}`);
}

let nextId = 0;
let socket: WebSocket;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP sans réponse : ${method}`));
    }, 20_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value as Record<string, unknown>); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

/** Évalue dans la page et rend la valeur, jamais une poignée d'objet distant. */
async function evaluate<T>(expression: string): Promise<T> {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const failure = response.exceptionDetails as { exception?: { description?: string } } | undefined;
  if (failure) throw new Error(failure.exception?.description ?? "évaluation refusée");
  return (response.result as { value: T }).value;
}

async function shot(name: string): Promise<void> {
  const response = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(String(response.data), "base64"));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attend qu'une lecture de la page devienne vraie. Toute la passe repose
 * dessus : un `sleep` fixe rend une preuve qui dépend de la charge de la
 * machine, donc une preuve qui ment un jour sur deux.
 */
async function until<T>(label: string, read: () => Promise<T>, ok: (value: T) => boolean, attempts = 40): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await read();
    if (ok(last)) return last;
    await sleep(250);
  }
  throw new Error(`${label} : jamais atteint (dernière lecture ${JSON.stringify(last)?.slice(0, 200)})`);
}

/** Le texte d'un bouton est ce que l'opérateur lit ; c'est donc la cible. */
const clickByText = (text: string): string => `(() => {
  const wanted = ${JSON.stringify(text)};
  const nodes = [...document.querySelectorAll('button, a, [role="tab"]')];
  const exact = nodes.find((node) => (node.textContent || '').trim() === wanted);
  const loose = nodes.find((node) => (node.textContent || '').trim().startsWith(wanted));
  const hit = exact || loose;
  if (!hit) return false;
  hit.click();
  return true;
})()`;

const setFieldValue = (selector: string, value: string): string => `(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return false;
  // React écoute l'événement, pas l'affectation : passer par le setter du
  // prototype est le seul moyen de lui faire voir la valeur.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set;
  setter.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const DIALOG_TEXT = `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  return dialog ? dialog.innerText : '';
})()`;

async function main(): Promise<void> {
  const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("aucun onglet à piloter sur le port CDP");

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("connexion CDP refusée"));
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result ?? {});
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  await send("Page.navigate", { url: `${ORIGIN}/settings/runtime` });
  await until("la PWA répond", () => evaluate<string>("document.readyState"), (state) => state === "complete");
  await sleep(1_500);

  if (await evaluate<boolean>(`!!document.querySelector('input[name="email"]')`)) {
    await evaluate(setFieldValue('input[name="email"]', EMAIL));
    await evaluate(clickByText("Continuer"));
    await until("le formulaire mot de passe", () => evaluate<boolean>(`!!document.querySelector('input[name="password"]')`), Boolean);
    await evaluate(setFieldValue('input[type="password"]', PASSWORD));
    const knownIds = await listMailpitMessageIds(EMAIL);
    await evaluate(clickByText("Se connecter"));
    await until("les cases du code de connexion", () => evaluate<boolean>(`!!document.querySelector('input[aria-label="1 / 6"]')`), Boolean);
    const loginCode = await readMailpitLoginCode(EMAIL, { knownIds, fallback: true });
    for (let index = 0; index < loginCode.length; index += 1) {
      await evaluate(setFieldValue(`input[aria-label="${index + 1} / 6"]`, loginCode[index]!));
    }
    await evaluate(clickByText("Vérifier et continuer"));
    await until("la fin de connexion", () => evaluate<string>("location.pathname"), (pathname) => !pathname.startsWith("/login"));
    await send("Page.navigate", { url: `${ORIGIN}/settings/runtime` });
    await sleep(2_500);
  }

  // Avec un runtime déclaré, l'écran s'ouvre sur « État » et le registre est un
  // onglet ; sans runtime, il EST la section d'accueil. Les deux sont légitimes.
  await evaluate(clickByText("Runtimes"));
  await sleep(800);

  const registry = await until(
    "le registre se prononce",
    () => evaluate<string>("document.body.innerText"),
    (text) =>
      text.includes("Aucun runtime déclaré")
      || text.includes("Lecture des runtimes déclarés")
      || text.includes("Dernier signe de vie")
      || text.includes("Runtimes déclarés"),
  );
  await shot("1-registre");
  const empty = registry.includes("Aucun runtime déclaré");
  record(
    "le registre nomme son état",
    true,
    empty ? "parc vide, et l'état vide porte le geste" : "au moins un runtime déclaré, en tableau",
  );
  record(
    "aucune valeur absente rendue par un tiret cadratin",
    // Le caractère s'écrit en échappement : le dépôt interdit sa présence
    // littérale, y compris dans la passe qui prouve qu'il ne s'affiche pas.
    !registry.includes("\u2014"),
    registry.includes("\u2014") ? "un tiret cadratin subsiste dans l'écran" : "les absences sont dites en mots",
  );

  const opened = await evaluate<boolean>(clickByText("Ajouter un runtime"));
  record("« Ajouter un runtime » est atteignable", opened, opened ? "bouton trouvé et cliqué" : "bouton introuvable");
  if (!opened) throw new Error("impossible d'ouvrir la fenêtre d'ajout");

  await until("la fenêtre d'ajout s'ouvre", () => evaluate<string>(DIALOG_TEXT), (text) => text.includes("Ajouter un runtime"));
  await shot("2-fenetre-ajout");
  record("l'ajout est déjà une fenêtre modale", true, "role=dialog portant « Ajouter un runtime »");

  const named = await evaluate<boolean>(setFieldValue("#runtime-add-name", DRAFT_NAME));
  record("le nom se saisit dans la fenêtre", named, named ? `« ${DRAFT_NAME} »` : "champ #runtime-add-name absent");
  if (!named) throw new Error("champ de nom introuvable");
  await sleep(300);

  await evaluate<boolean>(clickByText("Appairer depuis le serveur"));
  const ticketText = await until(
    "le ticket arrive",
    () => evaluate<string>(DIALOG_TEXT),
    (text) => text.includes(`Appairer ${DRAFT_NAME}`),
    60,
  );
  await shot("3-appairage-modal");

  const modal = await evaluate<{ count: number; ariaModal: string | null; hasTimer: boolean; hasClose: boolean }>(`(() => {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const dialog = dialogs[0];
    return {
      count: dialogs.length,
      ariaModal: dialog ? dialog.getAttribute('aria-modal') : null,
      hasTimer: !!(dialog && dialog.querySelector('[role="timer"]')),
      hasClose: !!(dialog && [...dialog.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Fermer')),
    };
  })()`);

  record(
    "l'appairage se joue dans une boîte modale",
    modal.ariaModal === "true",
    `aria-modal=${String(modal.ariaModal)}`,
  );
  record(
    "la fenêtre du nom devient celle du ticket",
    modal.count === 1 && !ticketText.includes("Comment openedbot joint ce runtime"),
    `${modal.count} boîte(s) montée(s)`,
  );
  record("le décompte vit dans la boîte", modal.hasTimer, modal.hasTimer ? "role=timer présent" : "aucun décompte");
  record("la boîte offre une sortie explicite", modal.hasClose, modal.hasClose ? "bouton « Fermer »" : "aucun bouton de sortie");
  record(
    "les deux étapes sont là",
    ticketText.includes("edge-setup link") && ticketText.includes("Ticket à coller à l’invite masquée"),
    "commande de lien et ticket",
  );

  // Le ticket ne sert qu'une fois : il n'a rien à faire hors de la boîte qui
  // le montre, ni dans le registre, ni dans un journal de la page.
  const leaked = await evaluate<boolean>(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const codes = [...document.querySelectorAll('code')];
    const value = codes.map((c) => (c.textContent || '').trim()).find((t) => /^[0-9a-f-]{36}\\./.test(t));
    if (!value || !dialog) return false;
    return [...document.querySelectorAll('body *')].some(
      (node) => !dialog.contains(node) && node.children.length === 0 && (node.textContent || '').includes(value),
    );
  })()`);
  record("le ticket ne sort pas de la boîte", !leaked, leaked ? "trouvé hors de la boîte modale" : "confiné à la fenêtre");

  await evaluate<boolean>(clickByText("Fermer"));
  await until("la boîte se referme", () => evaluate<number>(`document.querySelectorAll('[role="dialog"]').length`), (count) => count === 0);
  await shot("4-apres-fermeture");
  const timerLeft = await evaluate<number>(`document.querySelectorAll('[role="timer"]').length`);
  record("« Fermer » rend l'écran au registre", timerLeft === 0, "plus de boîte ni de décompte");

  socket.close();
}

try {
  await main();
} catch (error) {
  record("la passe se déroule", false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((result) => !result.ok);
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ origin: ORIGIN, results }, null, 2)}\n`);
console.log(`\n${results.length - failed.length}/${results.length} vérifications passées ; captures et rapport dans ${OUT}/`);
if (failed.length > 0) process.exit(1);
