/**
 * Dev-only Chromium pass for the MOBILE shell (drawer + assistant). Not a
 * product feature. Origin: http://localhost:1420 (Vite). Seed login from
 * E2E_* / seed defaults. Emulates an iPhone-class viewport with touch.
 *
 * Evidence lands in tmp/pwa-mobile: screenshots + results.json.
 */
import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMailpitMessageIds, readMailpitLoginCode } from "../../../scripts/lib/password-login";

const ORIGIN = process.env.E2E_ORIGIN?.trim() || "http://localhost:1420";
const EMAIL = process.env.E2E_EMAIL?.trim() || "dev@ohb.local";
const PASSWORD = process.env.E2E_PASSWORD || (() => { throw new Error("E2E_PASSWORD is not set: run `make setup` (it generates one in .env.local), or export it."); })();
const OUT = join(import.meta.dir, "../../../tmp/pwa-mobile");
// Le design system vit hors de la racine Vite (browser/ui-kit) : Vite le sert
// sous `/@fs/<chemin absolu>`.
const TOASTER_MODULE = `/@fs${join(import.meta.dir, "../../../browser/ui-kit/src/components/ui/toaster-clean.tsx")}`;

/**
 * iPhone 15 Pro Max : le gabarit le plus exigeant du parc : 430 × 932 pt,
 * Dynamic Island de 59 pt en haut, indicateur d'accueil de 34 pt en bas.
 */
const PHONE = {
  width: Number(process.env.E2E_PHONE_WIDTH ?? 430),
  height: Number(process.env.E2E_PHONE_HEIGHT ?? 932),
};
const SAFE = { top: 59, right: 0, bottom: 34, left: 0 };

mkdirSync(OUT, { recursive: true });

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} : ${detail}`);
}

async function shot(page: Page, name: string) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

async function sceneOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scene = document.querySelector<HTMLElement>("[data-mobile-scene]");
    if (!scene) return -1;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(scene).transform);
    return Math.round(matrix.m41);
  });
}

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth,
  );
}

async function swipeSheetBack(page: Page) {
  const box = await page.locator('[role="dialog"]').boundingBox();
  if (!box) throw new Error("dialog absent");
  const y = box.y + Math.min(240, Math.round(box.height * 0.42));
  const from = box.x + 10;
  const to = box.x + Math.round(box.width * 0.58);
  await page.mouse.move(from, y);
  await page.mouse.down();
  for (let x = from; x <= to; x += 24) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

async function sheetStackState(page: Page, backLabel: string) {
  return page.evaluate((label) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const back = dialog?.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
    const index = dialog?.querySelector<HTMLElement>("[data-sheet-index]");
    const hero = dialog?.querySelector<HTMLElement>("[data-sheet-index] h2");
    const rows = dialog?.querySelectorAll("[data-sheet-index] [data-inset-grouped-row]").length ?? 0;
    return {
      pushed: dialog?.querySelector("[data-sheet-pushed]") !== null,
      panel: dialog?.querySelector("[data-sheet-panel]") !== null,
      back: Boolean(back && back.getClientRects().length > 0),
      indexHidden: index?.getAttribute("aria-hidden") === "true",
      rows,
      hero: (hero?.textContent ?? "").trim(),
    };
  }, backLabel);
}

async function minTouchTarget(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    let min = Number.POSITIVE_INFINITY;
    for (const node of document.querySelectorAll<HTMLElement>(sel)) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      min = Math.min(min, rect.width, rect.height);
    }
    return min === Number.POSITIVE_INFINITY ? 0 : Math.round(min);
  }, selector);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "fr-FR",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  // Chromium rend `env(safe-area-inset-*)` toujours nul, même à la taille d'un
  // iPhone : la géométrie de zone sûre n'y est donc jamais prouvée. Toute
  // l'app lit ces quatre variables (`browser/ui-kit/src/styles/mobile.css`), et les fixer ici
  // reproduit exactement l'encoche et l'indicateur d'accueil d'iOS 26.
  await context.addInitScript(
    ([top, right, bottom, left]) => {
      const apply = () => {
        const style = document.createElement("style");
        style.textContent = `:root{--ohb-safe-top:${top}px;--ohb-safe-right:${right}px;--ohb-safe-bottom:${bottom}px;--ohb-safe-left:${left}px}`;
        document.head.append(style);
      };
      if (document.head) apply();
      else document.addEventListener("DOMContentLoaded", apply, { once: true });

      // PWA iOS installée : `navigator.standalone` + `display-mode: standalone`.
      Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
      const matchMedia = window.matchMedia.bind(window);
      // Un spread `{ ...media }` ne copie que les propriétés propres : les
      // méthodes de prototype (`addEventListener`, `addListener`…) seraient
      // perdues et `use-mobile.ts` planterait au montage. On force `matches`
      // sur l'objet réel, qui garde son prototype.
      const forced = (media: MediaQueryList, query: string) => {
        Object.defineProperty(media, "matches", { configurable: true, value: true });
        Object.defineProperty(media, "media", { configurable: true, value: query });
        return media;
      };
      window.matchMedia = ((query: string) => {
        const media = matchMedia(query);
        if (query.includes("display-mode: standalone") || query.includes("pointer: coarse")) {
          return forced(media, query);
        }
        return media;
      }) as typeof window.matchMedia;
    },
    [SAFE.top, SAFE.right, SAFE.bottom, SAFE.left] as const,
  );
  const page = await context.newPage();

  // ── login ──
  await page.goto(`${ORIGIN}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1_500);
  const loginShot = await shot(page, "00-login");
  const loginShell = await page.locator("[data-mobile-shell]").count();
  record("login: hors de la coque mobile", loginShell === 0, `shell=${loginShell} ${loginShot}`);
  const loginChrome = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-shell]");
    if (!shell) return null;
    const style = getComputedStyle(shell);
    return {
      standalone: shell.hasAttribute("data-pwa-standalone"),
      ios: shell.hasAttribute("data-ios-device"),
      paddingBottom: Math.round(Number.parseFloat(style.paddingBottom)),
    };
  });
  record(
    "login: PWA iOS sans padding safe-area du shell bureau",
    loginChrome !== null && loginChrome.standalone && loginChrome.ios && loginChrome.paddingBottom === 0,
    loginChrome
      ? `standalone=${loginChrome.standalone} ios=${loginChrome.ios} pb=${loginChrome.paddingBottom}px`
      : "shell absent",
  );
  // The address first ("Continuer"), then the password step.
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.getByRole("button", { name: "Continuer", exact: true }).click();
  await page.locator('input[name="password"]').fill(PASSWORD);
  const knownIds = await listMailpitMessageIds(EMAIL);
  await page.getByRole("button", { name: "Se connecter", exact: true }).click();
  const loginCode = await readMailpitLoginCode(EMAIL, { knownIds, fallback: true });
  for (let index = 0; index < loginCode.length; index += 1) {
    await page.getByLabel(`${index + 1} / 6`).fill(loginCode[index]!);
  }
  await page.getByRole("button", { name: "Vérifier et continuer", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  await page.waitForTimeout(800);
  record("login: landed", !page.url().includes("/onboarding"), page.url());

  // ── / : aperçu avec ses données, dans la coque drawer ──
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2_000);
  const homeShot = await shot(page, "01-home-overview");
  const shell = await page.locator("[data-mobile-shell]").count();
  const menuButton = page.locator('[data-mobile-header] button[aria-label="Ouvrir le menu"]');
  const sidebarTrigger = await page.locator('[data-slot="sidebar-trigger"]').count();
  const sheet = await page.locator('[data-slot="sidebar"][data-mobile="true"]').count();
  const cards = await page.locator("[data-slot='card'], section").count();
  record(
    "home: coque mobile, bouton menu, pas de Sheet ni de trigger bureau",
    shell === 1 && (await menuButton.count()) === 1 && sidebarTrigger === 0 && sheet === 0,
    `shell=${shell} menu=${await menuButton.count()} trigger=${sidebarTrigger} sheet=${sheet} sections=${cards} ${homeShot}`,
  );
  record("home: aucun débordement horizontal", await noHorizontalOverflow(page), `viewport ${PHONE.width}px`);
  const overviewGeometry = await page.evaluate(() => {
    const overview = document.querySelector<HTMLElement>("[data-mobile-overview]")?.getBoundingClientRect();
    const scene = document.querySelector<HTMLElement>("[data-mobile-scene]")?.getBoundingClientRect();
    return overview && scene
      ? { overviewBottom: Math.round(overview.bottom), sceneBottom: Math.round(scene.bottom) }
      : null;
  });
  record(
    "home: l'aperçu remplit la scène, aucune barre basse réservée",
    overviewGeometry !== null && Math.abs(overviewGeometry.overviewBottom - overviewGeometry.sceneBottom) <= 1,
    overviewGeometry
      ? `overviewBottom=${overviewGeometry.overviewBottom}px sceneBottom=${overviewGeometry.sceneBottom}px`
      : "géométrie absente",
  );
  const headerTargets = await minTouchTarget(page, "[data-mobile-header] button, [data-mobile-header] a");
  record("home: cibles tactiles de l'en-tête ≥ 44 px", headerTargets >= 44, `min=${headerTargets}px`);
  const overviewSafeRun = await page.evaluate(() => {
    const overview = document.querySelector<HTMLElement>("[data-mobile-overview]");
    if (!overview) return null;
    return Math.round(Number.parseFloat(getComputedStyle(overview).paddingBottom));
  });
  record(
    "home: la course de défilement se termine au-dessus de l'indicateur d'accueil",
    overviewSafeRun !== null && overviewSafeRun >= SAFE.bottom,
    `paddingBottom=${overviewSafeRun ?? "n/a"}px safeBottom=${SAFE.bottom}px`,
  );
  const floatingInstall = await page.locator('[data-slot="pwa-install-notice"]').count();
  const drawerInstallRow = await page.locator("[data-mobile-install-row]").count();
  record(
    "home: aucun bandeau d'installation flottant par-dessus le contenu",
    floatingInstall === 0,
    `flottant=${floatingInstall} ligneDuPanneau=${drawerInstallRow}`,
  );
  const headerTop = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>("[data-mobile-header]");
    if (!header) return null;
    return Math.round(Number.parseFloat(getComputedStyle(header).paddingTop));
  });
  record(
    "home: l'en-tête peint sous la Dynamic Island et s'en écarte de 59 px",
    headerTop === SAFE.top,
    `paddingTop=${headerTop ?? "n/a"}px safeTop=${SAFE.top}px`,
  );

  // ── ouvrir le panneau ──
  await menuButton.click();
  await page.waitForTimeout(450);
  const drawerShot = await shot(page, "02-drawer-open");
  const drawerOpen = await page.locator("[data-mobile-shell][data-drawer-open]").count();
  const offset = await sceneOffset(page);
  // GPT-like : aucun onglet ni raccourci dans le panneau : la liste des
  // conversations, et la ligne de l'opérateur (feuille Inset Grouped) en bas.
  const appLinks = await page.locator("[data-mobile-app-links], [role='tablist'], [data-mobile-tab-bar]").count();
  const operatorRow = await page
    .locator("[data-mobile-drawer] [data-slot='sidebar-footer'] button")
    .and(page.locator(":not([data-mobile-install-row] button)"))
    .count();
  const rosterLinks = await page.locator('[data-mobile-drawer] a[href^="/c/"], [data-mobile-drawer] a[href^="/g/"]').count();
  record(
    "drawer: scène glissée à 310 px, roster, ligne opérateur, AUCUN onglet",
    drawerOpen === 1 && offset === 310 && appLinks === 0 && operatorRow === 1 && rosterLinks > 0,
    `open=${drawerOpen} offset=${offset} tabs=${appLinks} operator=${operatorRow} roster=${rosterLinks} ${drawerShot}`,
  );
  const rowTargets = await minTouchTarget(page, "[data-mobile-drawer] [data-slot='sidebar-menu-button']");
  record("drawer: lignes ≥ 44 px", rowTargets >= 44, `min=${rowTargets}px`);

  // ── choisir une conversation ──
  const firstBot = page.locator('[data-mobile-drawer] a[href^="/c/"]').first();
  const botHref = await firstBot.getAttribute("href");
  await firstBot.click();
  await page.waitForURL("**/c/**", { timeout: 8_000 });
  await page.waitForTimeout(2_000);
  const chatShot = await shot(page, "03-conversation");
  const closedAfterNav = (await page.locator("[data-mobile-shell][data-drawer-open]").count()) === 0;
  const composer = await page.locator("textarea[data-composer]").count();
  const chatMenu = await page.locator('[data-mobile-header] button[aria-label="Ouvrir le menu"]').count();
  const chatMenuGlyph = await page.evaluate(() => {
    const svg = document.querySelector<SVGElement>('[data-mobile-header] button[aria-label="Ouvrir le menu"] svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const style = getComputedStyle(svg);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      color: style.color,
      stroke: style.stroke,
      opacity: style.opacity,
      visibility: style.visibility,
    };
  });
  const composerBox = await page.locator("textarea[data-composer]").boundingBox();
  record(
    "conversation: panneau refermé, en-tête drawer, composer dans le viewport",
    closedAfterNav && composer === 1 && chatMenu === 1 && composerBox !== null && composerBox.y + composerBox.height <= PHONE.height,
    `href=${botHref} closed=${closedAfterNav} composer=${composer} composerBottom=${composerBox ? Math.round(composerBox.y + composerBox.height) : "n/a"} menuGlyph=${JSON.stringify(chatMenuGlyph)} ${chatShot}`,
  );
  record("conversation: aucun débordement horizontal", await noHorizontalOverflow(page), "");
  const composerGeometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
    const root = box("[data-thread-composer]");
    const scene = box("[data-mobile-scene]");
    const pill = box("[data-composer-shell]");
    const input = box("[data-composer]");
    const attachment = box("[data-composer-attachment]");
    const voice = box("[data-composer-voice]");
    const primary = box("[data-composer-primary-action]");
    const trailing = voice ?? primary;
    if (!root || !scene || !pill || !input || !attachment || !trailing) return null;
    const trailingNode = document.querySelector<HTMLElement>(
      voice ? "[data-composer-voice]" : "[data-composer-primary-action]",
    )!;
    const hitSlop = Number.parseFloat(getComputedStyle(trailingNode, "::before").inset || "0");
    return {
      rootBottom: Math.round(root.bottom),
      sceneBottom: Math.round(scene.bottom),
      // Capsule → bas d'écran : ~8 pt au-dessus de l'indicateur, pas les 34 pt.
      pillClearance: Math.round(scene.bottom - pill.bottom),
      pillHeight: Math.round(pill.height),
      hairline: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>("[data-thread-composer]")!).borderTopWidth),
      // Vide : + | champ | mic. Brouillon : + | champ | send.
      emptyIso: voice !== null && primary === null,
      singleRow:
        Math.abs(input.bottom - attachment.bottom) <= 2 && Math.abs(attachment.bottom - trailing.bottom) <= 2,
      trailingHit: Math.round(trailing.height - hitSlop * 2),
      trailingRight: Math.round(trailing.right),
      rootRight: Math.round(root.right),
      enterKeyHint: document.querySelector<HTMLTextAreaElement>("[data-composer]")?.enterKeyHint ?? "",
    };
  });
  const visibleModelIndicator = await page.locator("[data-thread-model-indicator]:visible").count();
  record(
    "conversation: composer : une seule rangée, mic à vide, pas de filet, capsule collée à l'indicateur",
    composerGeometry !== null &&
      Math.abs(composerGeometry.rootBottom - composerGeometry.sceneBottom) <= 1 &&
      composerGeometry.singleRow &&
      composerGeometry.emptyIso &&
      composerGeometry.pillHeight <= 56 &&
      composerGeometry.hairline === 0 &&
      composerGeometry.pillClearance >= 8 &&
      composerGeometry.pillClearance < SAFE.bottom &&
      composerGeometry.trailingHit >= 44 &&
      composerGeometry.rootRight - composerGeometry.trailingRight <= 24 &&
      composerGeometry.enterKeyHint === "enter" &&
      visibleModelIndicator === 0,
    composerGeometry
      ? `rootBottom=${composerGeometry.rootBottom}px sceneBottom=${composerGeometry.sceneBottom}px pillHeight=${composerGeometry.pillHeight}px clearance=${composerGeometry.pillClearance}px hairline=${composerGeometry.hairline} (safe=${SAFE.bottom}) rangéeUnique=${composerGeometry.singleRow} emptyIso=${composerGeometry.emptyIso} trailingHit=${composerGeometry.trailingHit}px enterKeyHint=${composerGeometry.enterKeyHint} model=${visibleModelIndicator}`
      : "géométrie absente",
  );
  const threadAnchor = await page.evaluate(() => {
    const column = document.querySelector<HTMLElement>("[data-thread-messages]");
    if (!column) return null;
    const style = getComputedStyle(column);
    return {
      justify: style.justifyContent,
      minHeight: style.minHeight,
    };
  });
  record(
    "conversation: fil ancré : colonne min-h-full justify-end (assistant-ui)",
    threadAnchor?.justify === "flex-end" && threadAnchor.minHeight === "100%",
    threadAnchor ? `justify=${threadAnchor.justify} minHeight=${threadAnchor.minHeight}` : "colonne absente",
  );
  await page.locator("textarea[data-composer]").fill("iso");
  await page.locator("textarea[data-composer]").focus();
  const draftSwap = await page.evaluate(() => ({
    voice: document.querySelector("[data-composer-voice]") !== null,
    send: document.querySelector("[data-composer-primary-action]") !== null,
  }));
  record(
    "conversation: composer : brouillon remplace le mic par Envoyer",
    !draftSwap.voice && draftSwap.send,
    `voice=${draftSwap.voice} send=${draftSwap.send}`,
  );
  const focusedAui = await page.evaluate(() => {
    const input = document.querySelector<HTMLElement>("[data-composer]")?.getBoundingClientRect();
    const attachment = document.querySelector<HTMLElement>("[data-composer-attachment]")?.getBoundingClientRect();
    const send = document.querySelector<HTMLElement>("[data-composer-primary-action]")?.getBoundingClientRect();
    const pill = document.querySelector<HTMLElement>("[data-composer-shell]");
    const root = document.querySelector<HTMLElement>("[data-thread-composer]");
    if (!input || !attachment || !send || !pill || !root) return null;
    return {
      oneRow: attachment.top < input.bottom - 2 && attachment.bottom > input.top + 2,
      sendOnRight: send.left > attachment.right,
      sameToolbar: Math.abs(send.top - attachment.top) <= 4,
      radius: Number.parseFloat(getComputedStyle(pill).borderRadius),
      pad: Math.round(Number.parseFloat(getComputedStyle(root).paddingBottom)),
    };
  });
  const focusedShot = await shot(page, "03a-composer-focused-aui");
  record(
    "conversation: composer focus : une seule rangée (+ / champ / Envoyer), même capsule, 2 px au-dessus du clavier",
    focusedAui !== null &&
      focusedAui.oneRow &&
      focusedAui.sendOnRight &&
      focusedAui.sameToolbar &&
      focusedAui.radius >= 20 &&
      focusedAui.pad <= 2,
    focusedAui
      ? `oneRow=${focusedAui.oneRow} sendRight=${focusedAui.sendOnRight} toolbar=${focusedAui.sameToolbar} radius=${focusedAui.radius} pad=${focusedAui.pad} ${focusedShot}`
      : `géométrie absente ${focusedShot}`,
  );
  const singleLineHeight = await page.locator("textarea[data-composer]").evaluate((el) =>
    Math.round(el.getBoundingClientRect().height),
  );
  await page.locator("textarea[data-composer]").fill("ligne une\nligne deux\nligne trois\nligne quatre");
  await page.waitForTimeout(50);
  const grown = await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>("[data-composer]");
    if (!el) return null;
    return {
      height: Math.round(el.getBoundingClientRect().height),
      inline: el.style.height,
    };
  });
  const grownShot = await shot(page, "03b-composer-grown");
  record(
    "conversation: composer : un texte long agrandit le champ",
    grown !== null && grown.height >= singleLineHeight + 24,
    grown
      ? `single=${singleLineHeight} grown=${grown.height} inline=${grown.inline} ${grownShot}`
      : `géométrie absente ${grownShot}`,
  );
  await page.locator("[data-composer-primary-action]").click();
  await page.waitForTimeout(80);
  const afterSend = await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>("[data-composer]");
    return el ? document.activeElement === el : true;
  });
  record(
    "conversation: composer : Envoyer ferme le clavier (blur)",
    afterSend === false,
    `focused=${afterSend}`,
  );
  await page.locator("textarea[data-composer]").focus();
  await page.locator('[data-mobile-header] button[aria-label="Ouvrir le menu"]').click();
  await page.waitForTimeout(80);
  const afterDrawerOpen = await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>("[data-composer]");
    return {
      focused: el ? document.activeElement === el : true,
      open: document.querySelector("[data-mobile-shell][data-drawer-open]") !== null,
    };
  });
  record(
    "conversation: hamburger : le composer blur pour que le drawer prenne 100 %",
    afterDrawerOpen.focused === false && afterDrawerOpen.open,
    `focused=${afterDrawerOpen.focused} open=${afterDrawerOpen.open}`,
  );
  await page.locator('[data-mobile-scene] button[aria-label="Fermer le menu"]').click();
  await page.waitForTimeout(350);
  const placed = await page.evaluate(() => {
    const column = document.querySelector<HTMLElement>("[data-thread-messages]");
    const composer = document.querySelector<HTMLElement>("[data-thread-composer]");
    const last = column?.lastElementChild as HTMLElement | null;
    if (!column || !composer || !last) return null;
    return {
      gap: Math.round(composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
      pending: Boolean(document.querySelector("[data-thread-find-target^='message:pending:'], [data-thread-find-target^='pending:']")),
    };
  });
  record(
    "conversation: envoi : dernière bulle juste au-dessus du composer",
    placed !== null && placed.gap >= 0 && placed.gap <= 24,
    placed ? `gap=${placed.gap}px pending=${placed.pending}` : "géométrie absente",
  );
  await page.locator("textarea[data-composer]").fill("iso");
  await page.locator("textarea[data-composer]").focus();
  await page.waitForTimeout(50);
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>("[data-composer]")?.blur());
  await page.waitForTimeout(200);
  const collapsed = await page.evaluate(() => {
    const input = document.querySelector<HTMLElement>("[data-composer]")?.getBoundingClientRect();
    const attachment = document.querySelector<HTMLElement>("[data-composer-attachment]")?.getBoundingClientRect();
    const send = document.querySelector<HTMLElement>("[data-composer-primary-action]")?.getBoundingClientRect();
    if (!input || !attachment || !send) return null;
    return Math.abs(input.bottom - attachment.bottom) <= 2 && Math.abs(attachment.bottom - send.bottom) <= 2;
  });
  record(
    "conversation: composer blur : retour à la pilule d'une rangée",
    collapsed === true,
    `singleRow=${collapsed}`,
  );
  await page.locator("textarea[data-composer]").fill("");
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>("[data-composer]")?.blur());
  const standaloneChain = await page.evaluate((viewportHeight) => {
    const html = document.documentElement;
    const shell = document.querySelector<HTMLElement>("[data-shell]");
    const composer = document.querySelector<HTMLElement>("[data-thread-composer]");
    const pill = document.querySelector<HTMLElement>("[data-composer-shell]");
    if (!shell || !composer || !pill) return null;
    return {
      standalone: shell.hasAttribute("data-pwa-standalone"),
      ios: shell.hasAttribute("data-ios-device"),
      htmlHeight: Math.round(html.getBoundingClientRect().height),
      shellHeight: Math.round(shell.getBoundingClientRect().height),
      composerPad: Math.round(Number.parseFloat(getComputedStyle(composer).paddingBottom)),
      composerBottom: Math.round(composer.getBoundingClientRect().bottom),
      pillBottom: Math.round(pill.getBoundingClientRect().bottom),
      viewportHeight,
    };
  }, PHONE.height);
  record(
    "conversation: chaîne 100vh standalone : html/shell remplissent, capsule ~8 pt au-dessus de l'indicateur",
    standaloneChain !== null &&
      standaloneChain.standalone &&
      standaloneChain.ios &&
      standaloneChain.htmlHeight === PHONE.height &&
      standaloneChain.shellHeight === PHONE.height &&
      standaloneChain.composerBottom === PHONE.height &&
      standaloneChain.composerPad >= 8 &&
      standaloneChain.composerPad < SAFE.bottom &&
      standaloneChain.pillBottom <= PHONE.height - 8,
    standaloneChain
      ? `html=${standaloneChain.htmlHeight} shell=${standaloneChain.shellHeight} composerBottom=${standaloneChain.composerBottom} pad=${standaloneChain.composerPad} pillBottom=${standaloneChain.pillBottom}`
      : "chaîne absente",
  );
  // ── appui long sur une bulle → feuille d'actions ──
  const bubble = page.locator("[data-message-pressable]").last();
  const pressable = await bubble.count();
  let sheetShot = "n/a";
  let sheetActions = 0;
  let inlineOnTouch = 0;
  if (pressable > 0) {
    inlineOnTouch = await page.locator("[data-message-hover-actions]").count();
    const target = await bubble.boundingBox();
    if (target) {
      // `page.mouse` émet `pointerType: "mouse"`, que le geste ignore
      // volontairement (une souris a le survol). Seul un vrai contact tactile
      // doit ouvrir la feuille : CDP le dispatche.
      const cdp = await context.newCDPSession(page);
      const touch = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
      await page.waitForTimeout(700);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(400);
      sheetActions = await page.locator('[role="dialog"] ul button').count();
      sheetShot = await shot(page, "03b-message-action-sheet");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  }
  record(
    "conversation: pas d'icônes collées aux bulles ; l'appui long ouvre la feuille d'actions",
    pressable > 0 && inlineOnTouch === 0 && sheetActions > 0,
    `bulles=${pressable} icônesEnLigne=${inlineOnTouch} actionsDeLaFeuille=${sheetActions} ${sheetShot}`,
  );
  const actionTargets = await minTouchTarget(
    page,
    "[data-mobile-header] button:not(h1 button):not([data-mobile-header-subtitle] button), [data-mobile-header] a",
  );
  record("conversation: actions d'en-tête ≥ 44 px", actionTargets >= 44, `min=${actionTargets}px`);
  const headerIconSm = await page.locator("[data-mobile-header] [data-slot='button'][data-size='icon-sm']").count();
  record("conversation: en-tête sans Button icon-sm", headerIconSm === 0, `icon-sm=${headerIconSm}`);
  const workflowTrigger = page.locator("[data-mobile-header] [data-workflow-trigger]");
  if ((await workflowTrigger.count()) > 0) {
    const workflowHit = await minTouchTarget(page, "[data-mobile-header] [data-workflow-trigger]");
    record("conversation: workflow trigger ≥ 44 px", workflowHit >= 44, `min=${workflowHit}px`);
  }
  // Le sélecteur de tâche d'en-tête a été retiré (les conversations vivent
  // désormais dans la sidebar, voir `drawer: conversations du bot actif`
  // ci-dessous) : ce bloc tolère son absence et ne s'alarme que si un futur
  // bouton du titre, quel qu'il soit, retombait sous 44 pt de zone tactile.
  const taskPickerHit = await page.evaluate(() => {
    const pill = document.querySelector<HTMLElement>(
      "[data-mobile-header-subtitle] button, [data-mobile-header] h1 button",
    );
    if (!pill) return null;
    const rect = pill.getBoundingClientRect();
    const inset = Number.parseFloat(getComputedStyle(pill, "::before").inset || "0");
    return Math.round(rect.height - inset * 2);
  });
  record(
    "conversation: sélecteur de tâche : zone tactile ≥ 44 px (hit-slop)",
    taskPickerHit === null || taskPickerHit >= 44,
    `hit=${taskPickerHit ?? "absent"}px`,
  );

  // ── roue crantée : feuille iOS (liste → rubrique), pas la nav bureau ──
  // Sombre = référence ChatGPT iOS (IMG_7866). La classe `.dark` seule se
  // faisait écraser par `:root` (même spécificité) pour le canvas.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForTimeout(200);
  await page.locator('[data-mobile-header] button[aria-label^="Réglages de"]').click();
  await page.waitForTimeout(400);
  const botSheet = await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    const rgb = (el: Element | null, prop: "backgroundColor" | "color") => {
      if (!el) return "";
      const value = getComputedStyle(el)[prop];
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return match ? `${match[1]},${match[2]},${match[3]}` : value;
    };
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return null;
    const box = dialog.getBoundingClientRect();
    const rows = dialog.querySelectorAll("[data-inset-grouped-row]");
    const cards = dialog.querySelectorAll("[data-inset-grouped] ul");
    let minRow = Number.POSITIVE_INFINITY;
    let cardRadius = 0;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      minRow = Math.min(minRow, rect.height);
    }
    const firstCard = cards[0];
    if (firstCard) {
      cardRadius = Math.round(Number.parseFloat(getComputedStyle(firstCard).borderTopLeftRadius || "0"));
    }
    const label = dialog.querySelector("[data-inset-grouped-row] span span");
    const caption = dialog.querySelector("[data-inset-grouped] h2");
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      width: Math.round(box.width),
      sideNav: dialog.querySelectorAll("nav[class*='border-r']").length,
      groups: cards.length,
      rows: rows.length,
      minRow: minRow === Number.POSITIVE_INFINITY ? 0 : Math.round(minRow),
      cardRadius,
      sheetRadius: Math.round(Number.parseFloat(getComputedStyle(dialog).borderTopLeftRadius || "0")),
      canvas: rgb(dialog, "backgroundColor"),
      card: rgb(firstCard ?? null, "backgroundColor"),
      label: rgb(label, "color"),
      caption: rgb(caption, "color"),
    };
  });
  const botSheetShot = await shot(page, "03c-bot-settings-sheet");
  record(
    "conversation: roue crantée : feuille Inset Grouped, pas de nav latérale",
    botSheet !== null &&
      botSheet.sideNav === 0 &&
      botSheet.rows >= 8 &&
      botSheet.groups >= 3 &&
      botSheet.minRow >= 44 &&
      botSheet.cardRadius >= 18 &&
      botSheet.sheetRadius >= 28 &&
      botSheet.width >= PHONE.width - 2 &&
      botSheet.bottom >= PHONE.height - 2 &&
      botSheet.top <= 80,
    botSheet
      ? `top=${botSheet.top} bottom=${botSheet.bottom} w=${botSheet.width} nav=${botSheet.sideNav} groups=${botSheet.groups} rows=${botSheet.rows} minRow=${botSheet.minRow} cardR=${botSheet.cardRadius} sheetR=${botSheet.sheetRadius} ${botSheetShot}`
      : `absent ${botSheetShot}`,
  );
  record(
    "conversation: roue crantée : couleurs ChatGPT iOS (sombre)",
    botSheet !== null &&
      botSheet.canvas === "0,0,0" &&
      botSheet.card === "28,28,30" &&
      botSheet.label === "245,245,247" &&
      botSheet.caption === "142,142,147",
    botSheet
      ? `canvas=${botSheet.canvas} card=${botSheet.card} label=${botSheet.label} caption=${botSheet.caption}`
      : "absent",
  );
  await page.locator('[role="dialog"] [data-inset-grouped-row]').first().click();
  await page.waitForTimeout(300);
  const botPushed = await page.locator('[role="dialog"] button[aria-label="Retour aux réglages du bot"]').count();
  const backChrome = await page.evaluate(() => {
    const back = document.querySelector<HTMLElement>("[data-inset-back]");
    if (!back) return null;
    const color = getComputedStyle(back).color;
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const r = match ? Number(match[1]) : -1;
    const g = match ? Number(match[2]) : -1;
    const b = match ? Number(match[3]) : -1;
    return { color, text: (back.textContent ?? "").trim(), systemBlue: b > 180 && r < 80 && g < 160 };
  });
  const botPushedShot = await shot(page, "03d-bot-settings-pushed");
  record(
    "conversation: roue crantée : rubrique poussée avec Retour",
    botPushed === 1,
    `back=${botPushed} ${botPushedShot}`,
  );
  record(
    "conversation: Retour : bleu système iOS, pas le primary console",
    backChrome?.systemBlue === true && (backChrome.text === "Retour" || backChrome.text.includes("Retour")),
    backChrome ? `color=${backChrome.color} text=${backChrome.text}` : "absent",
  );
  const primarySkin = await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('[role="dialog"] [data-slot="button"][data-variant="primary"]');
    if (!btn) return null;
    const image = getComputedStyle(btn).backgroundImage;
    return { image, hasGradient: image.includes("gradient") };
  });
  record(
    "conversation: Enregistrer, pas de gradient BoardUI",
    primarySkin !== null && !primarySkin.hasGradient,
    primarySkin ? `image=${primarySkin.image}` : "primary absent",
  );
  const pathBeforeBotSwipe = new URL(page.url()).pathname;
  await swipeSheetBack(page);
  const botAfterSwipe = await sheetStackState(page, "Retour aux réglages du bot");
  const botSwipeShot = await shot(page, "03d2-bot-settings-swipe-pop");
  record(
    "conversation: roue crantée : swipe-back in-sheet revient à l'index",
    !botAfterSwipe.pushed &&
      !botAfterSwipe.panel &&
      !botAfterSwipe.back &&
      !botAfterSwipe.indexHidden &&
      botAfterSwipe.rows >= 8 &&
      new URL(page.url()).pathname === pathBeforeBotSwipe,
    `pushed=${botAfterSwipe.pushed} panel=${botAfterSwipe.panel} back=${botAfterSwipe.back} hidden=${botAfterSwipe.indexHidden} rows=${botAfterSwipe.rows} path=${new URL(page.url()).pathname} ${botSwipeShot}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.locator('[data-mobile-header] button[aria-label="Runtime Hermes (ordinateur)"]').click();
  await page.waitForTimeout(400);
  const computerSheet = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return null;
    const box = dialog.getBoundingClientRect();
    return {
      close: dialog.querySelector("[data-inset-close]") !== null,
      bottom: Math.round(box.bottom),
      top: Math.round(box.top),
    };
  });
  const computerShot = await shot(page, "03d3-computer-sheet");
  record(
    "conversation: computer : feuille ancrée, close inset",
    computerSheet !== null && computerSheet.close && computerSheet.bottom >= PHONE.height - 2,
    computerSheet
      ? `close=${computerSheet.close} top=${computerSheet.top} bottom=${computerSheet.bottom} ${computerShot}`
      : `absent ${computerShot}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.evaluate(async (toasterModule: string) => {
    const mod = await import(toasterModule);
    mod.toast.success("« Bloub » enregistré.");
  }, TOASTER_MODULE);
  await page.waitForTimeout(500);
  const toastGeom = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".ui-tsc__toast .ui-tsc__card");
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const title = el.querySelector<HTMLElement>(".ui-tsc__title");
    const icon = el.querySelector<HTMLElement>(".ui-tsc__status");
    const titleStyle = title ? getComputedStyle(title) : null;
    const iconBox = icon?.getBoundingClientRect();
    return {
      top: Math.round(box.top),
      bottom: Math.round(window.innerHeight - box.bottom),
      left: Math.round(box.left),
      width: Math.round(box.width),
      height: Math.round(box.height),
      radius: Math.round(Number.parseFloat(style.borderTopLeftRadius || "0")),
      fontSize: titleStyle ? Math.round(Number.parseFloat(titleStyle.fontSize || "0")) : 0,
      icon: iconBox ? Math.round(Math.min(iconBox.width, iconBox.height)) : 0,
      shadow: style.boxShadow,
    };
  });
  const toastShot = await shot(page, "03e-toast-banner");
  // Contrat affectUI sous 600 px : pleine largeur avec gouttières de 12 px,
  // posé en bas au-dessus de l'indicateur d'accueil, rayon 10, titre 13 px,
  // icône de statut 16 px.
  record(
    "conversation: toast affectUI, bas, gouttières 12, rayon 10",
    toastGeom !== null &&
      toastGeom.bottom >= SAFE.bottom - 4 &&
      toastGeom.bottom <= SAFE.bottom + 28 &&
      toastGeom.left >= 10 &&
      toastGeom.left <= 14 &&
      toastGeom.width >= PHONE.width - 28 &&
      toastGeom.radius === 10 &&
      toastGeom.fontSize === 13 &&
      toastGeom.height >= 44 &&
      toastGeom.icon >= 16,
    toastGeom
      ? `bottom=${toastGeom.bottom} left=${toastGeom.left} w=${toastGeom.width} h=${toastGeom.height} r=${toastGeom.radius} fs=${toastGeom.fontSize} icon=${toastGeom.icon} ${toastShot}`
      : `absent ${toastShot}`,
  );
  await page.evaluate(async (toasterModule: string) => {
    const mod = await import(toasterModule);
    mod.toast.dismiss();
  }, TOASTER_MODULE);
  await page.waitForTimeout(350);

  // ── geste : balayage depuis le bord gauche ──
  // y=90 : pile sur le lien marque (`/`). Un clic fantôme en fin de geste
  // redirigait vers l'aperçu, c'est le cas à prouver.
  await page.locator("textarea[data-composer]").focus();
  await page.mouse.move(6, 90);
  await page.mouse.down();
  for (let x = 6; x <= 260; x += 24) {
    await page.mouse.move(x, 90);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(450);
  const swipeShot = await shot(page, "04-edge-swipe");
  const swipedOpen = await page.locator("[data-mobile-shell][data-drawer-open]").count();
  const composerHeldFocus = await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>("[data-composer]");
    return el ? document.activeElement === el : false;
  });
  record("geste: balayage du bord ouvre le panneau", swipedOpen === 1, `open=${swipedOpen} offset=${await sceneOffset(page)} ${swipeShot}`);
  record(
    "geste: swipe drawer : le composer blur (sidebar à 100 %)",
    composerHeldFocus === false,
    `focused=${composerHeldFocus}`,
  );
  record(
    "geste: le balayage ne navigue pas (pas de clic fantôme vers l'aperçu)",
    page.url().includes("/c/"),
    page.url(),
  );
  await page.locator('[data-mobile-scene] button[aria-label="Fermer le menu"]').click();
  await page.waitForTimeout(450);
  const tapClosed = (await page.locator("[data-mobile-shell][data-drawer-open]").count()) === 0;
  record("geste: tap sur la scène referme", tapClosed, `offset=${await sceneOffset(page)}`);

  // ── nav-user : feuille opérateur (même chrome que la roue), pas /settings ──
  await page.locator('[data-mobile-header] button[aria-label="Ouvrir le menu"]').click();
  await page.waitForTimeout(450);
  // Le tiroir rouvert depuis `/c/…` : la sous-liste des conversations du bot
  // actif (`BotConversationList`) doit être là, avec des lignes ≥ 44 pt,
  // c'est elle qui remplace le sélecteur de tâche de l'en-tête.
  const conversationRows = await page.locator("[data-mobile-drawer] [data-conversation-row]").count();
  const conversationHit = await minTouchTarget(page, "[data-mobile-drawer] [data-conversation-row]");
  record(
    "drawer: conversations du bot actif ≥ 44 px",
    conversationRows > 0 && conversationHit >= 44,
    `rows=${conversationRows} min=${conversationHit}px`,
  );
  const pathBeforeOperator = new URL(page.url()).pathname;
  await page.locator("[data-mobile-drawer] [data-nav-user]").click();
  await page.waitForTimeout(400);
  const drawerUnderSheet = await page.locator("[data-mobile-shell][data-drawer-open]").count();
  const offsetUnderSheet = await sceneOffset(page);
  record(
    "drawer: nav-user : le tiroir reste ouvert sous la feuille",
    drawerUnderSheet === 1 && offsetUnderSheet === 310,
    `open=${drawerUnderSheet} offset=${offsetUnderSheet}`,
  );
  const operatorSheet = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return null;
    const box = dialog.getBoundingClientRect();
    const rows = dialog.querySelectorAll("[data-inset-grouped-row]");
    const cards = dialog.querySelectorAll("[data-inset-grouped] ul");
    let minRow = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      minRow = Math.min(minRow, rect.height);
    }
    const firstCard = cards[0];
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      width: Math.round(box.width),
      sideNav: dialog.querySelectorAll("nav[class*='border-r']").length,
      groups: cards.length,
      rows: rows.length,
      minRow: minRow === Number.POSITIVE_INFINITY ? 0 : Math.round(minRow),
      cardRadius: firstCard
        ? Math.round(Number.parseFloat(getComputedStyle(firstCard).borderTopLeftRadius || "0"))
        : 0,
      sheetRadius: Math.round(Number.parseFloat(getComputedStyle(dialog).borderTopLeftRadius || "0")),
      menu: dialog.querySelectorAll("[role='menu'], [role='menuitem']").length,
    };
  });
  const operatorSheetShot = await shot(page, "04b-operator-settings-sheet");
  const pathAfterOperator = new URL(page.url()).pathname;
  record(
    "drawer: nav-user : feuille Inset Grouped, pas de navigation",
    operatorSheet !== null &&
      operatorSheet.sideNav === 0 &&
      operatorSheet.menu === 0 &&
      operatorSheet.rows >= 8 &&
      operatorSheet.groups >= 3 &&
      operatorSheet.minRow >= 44 &&
      operatorSheet.cardRadius >= 18 &&
      operatorSheet.sheetRadius >= 28 &&
      operatorSheet.width >= PHONE.width - 2 &&
      operatorSheet.bottom >= PHONE.height - 2 &&
      operatorSheet.top <= 80 &&
      pathAfterOperator === pathBeforeOperator &&
      pathAfterOperator.includes("/c/"),
    operatorSheet
      ? `path=${pathAfterOperator} top=${operatorSheet.top} bottom=${operatorSheet.bottom} w=${operatorSheet.width} nav=${operatorSheet.sideNav} groups=${operatorSheet.groups} rows=${operatorSheet.rows} minRow=${operatorSheet.minRow} cardR=${operatorSheet.cardRadius} sheetR=${operatorSheet.sheetRadius} ${operatorSheetShot}`
      : `absent path=${pathAfterOperator} ${operatorSheetShot}`,
  );
  // La première ligne de la feuille est le lien « À traiter » (navigation
  // vers /inbox) : on pousse la première rubrique de réglages, un bouton.
  await page.locator('[role="dialog"] button[data-inset-grouped-row]').first().click();
  await page.waitForTimeout(300);
  const operatorPushed = await page.locator('[role="dialog"] button[aria-label="Retour aux réglages"]').count();
  const operatorPushedShot = await shot(page, "04c-operator-settings-pushed");
  record(
    "drawer: nav-user : rubrique poussée avec Retour",
    operatorPushed === 1 && new URL(page.url()).pathname === pathBeforeOperator,
    `back=${operatorPushed} path=${new URL(page.url()).pathname} ${operatorPushedShot}`,
  );
  await swipeSheetBack(page);
  const operatorAfterSwipe = await sheetStackState(page, "Retour aux réglages");
  const operatorSwipeShot = await shot(page, "04c2-operator-settings-swipe-pop");
  record(
    "drawer: nav-user : swipe-back in-sheet revient à l'index",
    !operatorAfterSwipe.pushed &&
      !operatorAfterSwipe.panel &&
      !operatorAfterSwipe.back &&
      !operatorAfterSwipe.indexHidden &&
      operatorAfterSwipe.rows >= 8 &&
      new URL(page.url()).pathname === pathBeforeOperator,
    `pushed=${operatorAfterSwipe.pushed} panel=${operatorAfterSwipe.panel} back=${operatorAfterSwipe.back} hidden=${operatorAfterSwipe.indexHidden} rows=${operatorAfterSwipe.rows} hero=${operatorAfterSwipe.hero} path=${new URL(page.url()).pathname} ${operatorSwipeShot}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const sheetGone = await page.locator("[data-operator-settings]").count();
  const drawerAfterSheet = await page.locator("[data-mobile-shell][data-drawer-open]").count();
  const offsetAfterSheet = await sceneOffset(page);
  record(
    "drawer: nav-user : fermer la feuille laisse le tiroir ouvert",
    sheetGone === 0 && drawerAfterSheet === 1 && offsetAfterSheet === 310,
    `sheet=${sheetGone} open=${drawerAfterSheet} offset=${offsetAfterSheet} path=${new URL(page.url()).pathname}`,
  );

  // ── réglages : liste groupée puis rubrique poussée ──
  await page.goto(`${ORIGIN}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1_200);
  const settingsShot = await shot(page, "05-settings-list");
  const settingsRows = await page.locator("[data-mobile-settings] a").count();
  const settingsMenu = await page.locator('[data-mobile-header] button[aria-label="Ouvrir le menu"]').count();
  record(
    "settings: liste groupée sous en-tête drawer",
    settingsRows >= 12 && settingsMenu === 1,
    `rows=${settingsRows} menu=${settingsMenu} ${settingsShot}`,
  );
  const settingsTargets = await minTouchTarget(page, "[data-mobile-settings] a, [data-mobile-settings] button");
  record("settings: lignes ≥ 44 px", settingsTargets >= 44, `min=${settingsTargets}px`);
  await page.locator('[data-mobile-settings] a[href="/settings/runtime"]').click();
  await page.waitForURL("**/settings/runtime", { timeout: 8_000 });
  await page.waitForTimeout(1_200);
  const runtimeShot = await shot(page, "06-settings-runtime-pushed");
  const back = page.locator('[data-mobile-header] a[aria-label="Retour"]');
  record("settings/runtime: en-tête « Retour »", (await back.count()) === 1, `${runtimeShot}`);
  record("settings/runtime: aucun débordement horizontal", await noHorizontalOverflow(page), "");
  const runtimeFooter = await page.evaluate(() => {
    const footer = document.querySelector<HTMLElement>("[data-mobile-action-footer]");
    const pane = document.querySelector<HTMLElement>("[data-mobile-settings]");
    if (!footer || !pane) return null;
    const fr = footer.getBoundingClientRect();
    const pr = pane.getBoundingClientRect();
    const scroll = pane.querySelector(":scope > .scrollbar-subtle");
    return {
      position: getComputedStyle(footer).position,
      bottom: Math.round(fr.bottom),
      paneBottom: Math.round(pr.bottom),
      inScroll: scroll ? scroll.contains(footer) : false,
      minHit: Math.round(Math.min(fr.height, ...[...footer.querySelectorAll("button")].map((btn) => btn.getBoundingClientRect().height))),
    };
  });
  record(
    "settings/runtime: CTA footer pin, pas fixed, hors scroll",
    runtimeFooter !== null
      && runtimeFooter.position !== "fixed"
      && !runtimeFooter.inScroll
      && Math.abs(runtimeFooter.bottom - runtimeFooter.paneBottom) <= 2
      && runtimeFooter.minHit >= 44,
    runtimeFooter
      ? `pos=${runtimeFooter.position} inScroll=${runtimeFooter.inScroll} bottom=${runtimeFooter.bottom}/${runtimeFooter.paneBottom} hit=${runtimeFooter.minHit}`
      : "footer absent",
  );
  const footerLabel = await page.evaluate(() => {
    const footer = document.querySelector<HTMLElement>("[data-mobile-action-footer]");
    const btn = footer?.querySelector<HTMLElement>("button, a, [data-slot='button']");
    if (!btn) return null;
    const br = btn.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(btn);
    const tr = range.getBoundingClientRect();
    const style = getComputedStyle(btn);
    return {
      delta: Math.abs((br.left + br.right) / 2 - (tr.left + tr.right) / 2),
      justify: style.justifyContent,
      textAlign: style.textAlign,
    };
  });
  record(
    "settings/runtime: label CTA centré dans la pilule",
    footerLabel !== null && footerLabel.justify === "center" && footerLabel.delta <= 2,
    footerLabel
      ? `justify=${footerLabel.justify} textAlign=${footerLabel.textAlign} Δ=${footerLabel.delta.toFixed(1)}px`
      : "bouton absent",
  );
  await back.click();
  await page.waitForURL("**/settings", { timeout: 8_000 });
  record("settings/runtime: retour → /settings", page.url().endsWith("/settings"), page.url());
  await page.locator('[data-mobile-settings] a[href="/settings/appearance"]').click();
  await page.waitForURL("**/settings/appearance", { timeout: 8_000 });
  await page.waitForTimeout(800);
  const appearanceGeom = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>("[data-mobile-settings]");
    if (!pane) return null;
    const canvas = getComputedStyle(pane).backgroundColor;
    const cards = [...pane.querySelectorAll<HTMLElement>("[data-inset-grouped] ul")];
    const bordered = cards.filter((card) => getComputedStyle(card).borderTopWidth !== "0px").length;
    let minRow = Number.POSITIVE_INFINITY;
    for (const row of pane.querySelectorAll("[data-inset-grouped-row]")) {
      const rect = row.getBoundingClientRect();
      minRow = Math.min(minRow, rect.height);
    }
    return { canvas, bordered, minRow: minRow === Number.POSITIVE_INFINITY ? 0 : Math.round(minRow), rows: pane.querySelectorAll("[data-inset-grouped-row]").length };
  });
  const appearanceShot = await shot(page, "06b-settings-appearance");
  record(
    "settings/appearance: canvas groupé, cartes sans stroke, lignes ≥ 44",
    appearanceGeom !== null &&
      (appearanceGeom.canvas.includes("242, 242, 247") || appearanceGeom.canvas === "rgb(0, 0, 0)") &&
      appearanceGeom.bordered === 0 &&
      appearanceGeom.minRow >= 44 &&
      appearanceGeom.rows >= 3,
    appearanceGeom
      ? `canvas=${appearanceGeom.canvas} bordered=${appearanceGeom.bordered} minRow=${appearanceGeom.minRow} rows=${appearanceGeom.rows} ${appearanceShot}`
      : `absent ${appearanceShot}`,
  );

  // ── thème sombre : couleur de barre d'état ──
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1_500);
  const darkShot = await shot(page, "07-home-dark");
  const themeColors = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map((m) => m.content),
  );
  record(
    "dark: meta theme-color suit le fond",
    themeColors.length === 2 && themeColors.every((c) => c === "#121212"),
    `${themeColors.join(",")} ${darkShot}`,
  );

  await browser.close();

  const failed = results.filter((row) => !row.ok);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ origin: ORIGIN, viewport: PHONE, results, failed: failed.length }, null, 2));
  if (failed.length) {
    console.error(`\n${failed.length} assertion(s) failed. Evidence: ${OUT}`);
    process.exit(1);
  }
  console.log(`\nAll assertions passed. Evidence: ${OUT}`);
}

await main();
