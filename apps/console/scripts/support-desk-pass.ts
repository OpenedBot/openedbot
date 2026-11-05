/**
 * Passe navigateur du GUICHET DE SUPPORT, des deux côtés à la fois.
 *
 * Ce que seul un navigateur peut prouver, et que ni `make e2e-support` (HTTP
 * pur) ni `make test-unit` (DOM simulé) ne prouvent :
 *
 *  - une image jointe s'AFFICHE réellement (`naturalWidth > 0`), donc la route
 *    gardée, l'URL d'objet et la balise tiennent ensemble ;
 *  - le markdown est RENDU (un `<strong>` dans le DOM), pas affiché en clair ;
 *  - la bulle du staff a un fond visible (le jeton de couleur existe) ;
 *  - le fil du backoffice occupe la hauteur du panneau, sans filet horizontal ;
 *  - l'infobulle du rail paraît au survol, tout de suite ;
 *  - la pastille de la porte d'en-tête du visiteur apparaît HORS de la page
 *    support, sur une réponse arrivée par SSE.
 *
 * Dev seulement. Deux origines : la PWA (1420) et le backoffice (1421). Les
 * identifiants viennent de `E2E_*` / des défauts du seed.
 *
 * Le fil créé est EFFACÉ à la fin, par la route staff, quoi qu'il arrive :
 * cette passe écrit dans un vrai guichet, et un faux visiteur laissé dans la
 * file d'attente est quelqu'un que l'équipe lira.
 *
 * Preuves dans tmp/support-desk : captures + results.json.
 */
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMailpitMessageIds, readMailpitLoginCode } from "../../../scripts/lib/password-login";

const WEB = process.env.E2E_ORIGIN?.trim() || "http://localhost:1420";
const ADMIN = process.env.E2E_ADMIN_ORIGIN?.trim() || "http://localhost:1421";
const API = process.env.E2E_API_URL?.trim() || "http://127.0.0.1:8790";
const EMAIL = process.env.E2E_EMAIL?.trim() || "dev@openedbot.local";
const PASSWORD = process.env.E2E_PASSWORD || (() => { throw new Error("E2E_PASSWORD is not set: run `make setup` (it generates one in .env.local), or export it."); })();
const STAFF_EMAIL = process.env.DEV_STAFF_EMAIL?.trim() || "staff@openedbot.dev";
const OUT = join(import.meta.dir, "../../../tmp/support-desk");

/**
 * La « capture du bug » envoyée par la passe : une icône du dépôt, 192 px de
 * côté et 30 ko.
 *
 * Un PNG d'un pixel aurait suffi au serveur, pas à la PREUVE : une image de
 * deux pixels s'affiche comme un point, et une capture d'écran de la passe ne
 * montrerait alors rien de lisible. Une image de taille réelle traverse aussi
 * la réduction côté client (plafond 1568 px) sans la déclencher.
 */
const ATTACHMENT = join(import.meta.dir, "../public/apple-touch-icon-180x180.png");

mkdirSync(OUT, { recursive: true });

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} : ${detail}`);
}

async function shot(page: Page, name: string): Promise<string> {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

/** Les deux apps lisent la langue dans `localStorage` avant le premier rendu. */
async function french(page: Page, origin: string): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("openedbot:locale", "fr");
    } catch {
      // Stockage refusé : la passe se jouera en anglais, et le dira.
    }
  });
  void origin;
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  /**
   * Le fil sur lequel la passe a écrit, et s'il a été CRÉÉ par elle.
   *
   * L'identité vient du réseau, pas de `localStorage` : quand la route REJOINT
   * le dernier fil du compte (le cas normal depuis 0078), elle ne rend aucun
   * jeton, donc le client n'écrit rien, et la passe ne saurait pas de quel fil
   * elle parle.
   *
   * `created` commande l'effacement : une passe n'efface JAMAIS un fil qu'elle
   * n'a pas ouvert. Le fil d'un vrai opérateur, rejoint par la porte compte,
   * appartient à cet opérateur.
   */
  let conversationId: string | null = null;
  let created = false;
  try {
    browser = await chromium.launch({ headless: true });

    /* ------------------------ PWA : le visiteur ------------------------- */

    const web = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR" });
    const page = await web.newPage();
    page.on("response", (response) => {
      // LE CHEMIN EXACT, sans suffixe. `includes` attrapait aussi
      // `POST …/conversations/<id>/messages`, qui rend 201 avec un instantané :
      // la passe croyait alors avoir CRÉÉ le fil qu'elle venait seulement de
      // rejoindre, et l'effaçait à la fin. Un fil d'opérateur perdu pour un
      // `includes`.
      const path = new URL(response.url()).pathname.replace(/\/+$/, "");
      if (!path.endsWith("/api/support/conversations")) return;
      if (response.request().method() !== "POST") return;
      void response
        .json()
        .then((body: { conversationId?: string; token?: string }) => {
          if (typeof body?.conversationId !== "string") return;
          conversationId = body.conversationId;
          // 201 = ouvert par cette passe ; 200 = fil du compte rejoint.
          if (response.status() === 201) created = true;
        })
        .catch(() => {
          // Une réponse qui n'est pas du JSON n'est pas une ouverture de fil.
        });
    });
    await french(page, WEB);
    await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
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
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
    await page.waitForTimeout(1_200);
    record("pwa: session ouverte", !page.url().includes("/login"), page.url());

    // Dans l'application, le guichet est une PAGE (`/support`) : la bulle ne
    // reste que hors de l'application (`support-launcher-visibility.ts`), et
    // chaque en-tête porte la porte vers la page.
    await page.goto(`${WEB}/support`, { waitUntil: "domcontentloaded" });
    const composer = page.locator('[data-composer]');
    await composer.waitFor({ state: "visible", timeout: 15_000 });
    record("pwa: la page support s'ouvre sur son composer", true, "data-composer visible");

    // Repartir d'un fil NEUF quand l'historique en propose un : c'est ce qui
    // rend la passe déterministe, et c'est le chemin `fresh` du serveur.
    // Au bureau, la page porte l'historique dans une carte à droite
    // (`[data-support-history-canvas]`) avec son propre « Nouvelle
    // conversation » ; ailleurs, la porte `[data-support-history-toggle]`.
    await page.waitForTimeout(1_500);
    const historyCanvas = page.locator("[data-support-history-canvas]:visible");
    const historyToggle = page.locator("[data-support-history-toggle]:visible");
    const freshName = /Nouvelle conversation|New conversation/;
    if (await historyCanvas.count() > 0) {
      await historyCanvas.getByRole("button", { name: freshName }).first().click();
      await page.waitForTimeout(400);
      record("pwa: l'historique propose un fil neuf", true, "carte historique puis composer vide");
    } else if (await historyToggle.count() > 0) {
      await historyToggle.click();
      const fresh = page.getByRole("button", { name: freshName }).first();
      await fresh.click();
      await page.waitForTimeout(400);
      record("pwa: l'historique propose un fil neuf", true, "vue historique puis composer vide");
    } else {
      record("pwa: aucun fil antérieur", true, "le premier envoi crée le fil");
    }

    // Le compteur de caractères, à l'approche du plafond.
    await composer.fill("x".repeat(3_300));
    const counter = page.locator("text=/3300 \\/ 4000/");
    const counterSeen = await counter.count() > 0;
    record("pwa: le compteur paraît près du plafond", counterSeen, counterSeen ? "3300 / 4000" : "absent");

    // Un message en markdown, avec une capture jointe.
    await composer.fill("Voici **le bug** et sa capture.\n\n- étape 1\n- étape 2");
    await page.locator('input[type="file"]').setInputFiles(ATTACHMENT);
    await page.waitForTimeout(600);
    const thumb = await page.locator("[data-composer-attachments] img").count();
    record("pwa: la vignette est dans la pilule", thumb === 1, `vignettes=${thumb}`);
    await shot(page, "01-composer");

    await page.locator('[data-composer-action="send"]').click();
    await page.waitForTimeout(2_500);

    const strong = await page.locator('[aria-label="Support"] strong, section strong').count();
    record("pwa: le markdown est rendu", strong > 0, `<strong> = ${strong}`);

    const image = page.locator("section img").last();
    await image.waitFor({ state: "visible", timeout: 15_000 });
    const natural = await image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
    record("pwa: la capture s'affiche vraiment", natural > 0, `naturalWidth=${natural}`);
    await shot(page, "02-fil-visiteur");

    record(
      "pwa: le fil est identifié",
      conversationId !== null,
      conversationId === null
        ? "aucune ouverture observée sur le réseau"
        : `${conversationId} (${created ? "créé par la passe" : "fil du compte rejoint"})`,
    );

    // HORS de la page support : c'est là que la pastille de la porte d'en-tête
    // doit apparaître.
    await page.goto(`${WEB}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_500);
    await shot(page, "03-hors-support");

    /* ---------------------- backoffice : le staff ----------------------- */

    const admin = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR" });
    const staff = await admin.newPage();
    await french(staff, ADMIN);
    await staff.goto(`${ADMIN}/login`, { waitUntil: "networkidle" });
    const codeResponse = staff.waitForResponse((response) =>
      response.url().includes("/api/pro/staff/login/code") && response.request().method() === "POST");
    await staff.locator('input[type="email"]').first().fill(STAFF_EMAIL);
    await staff.locator("button[type='submit']").first().click();
    const codeBody = await (await codeResponse).json() as { devCode?: string };
    if (!codeBody.devCode) {
      record("admin: code de connexion", false, "devCode absent (API hors développement)");
    } else {
      await staff.locator('input[autocomplete="one-time-code"]').first().fill(codeBody.devCode);
    }
    await staff.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
    await staff.waitForTimeout(1_500);
    record("admin: session staff ouverte", !staff.url().includes("/login"), staff.url());

    // Le compteur du rail, AVANT d'ouvrir le fil : l'ouvrir le marque lu.
    const supportNav = staff.getByRole("link", { name: "Support" }).first();
    await supportNav.waitFor({ state: "visible", timeout: 10_000 });
    const badge = await supportNav.locator("span").filter({ hasText: /^\d+$/ }).first().textContent()
      .catch(() => null);
    record("admin: le rail compte les demandes", badge !== null && Number(badge) >= 1, `badge=${badge ?? "absent"}`);

    // L'infobulle, au survol, tout de suite.
    await supportNav.hover();
    let tooltip = "";
    for (let attempt = 0; attempt < 15; attempt += 1) {
      tooltip = (await staff.locator('[role="tooltip"]').first().textContent({ timeout: 100 }).catch(() => "")) ?? "";
      if (tooltip) break;
      await staff.waitForTimeout(100);
    }
    record("admin: infobulle instantanée au survol", tooltip.length > 0, tooltip || "aucune");
    await shot(staff, "04-rail-infobulle");

    await supportNav.click();
    await staff.waitForTimeout(1_200);
    await shot(staff, "05-file-attente");

    const row = staff.getByText(EMAIL).first();
    await row.waitFor({ state: "visible", timeout: 10_000 });
    await row.click();
    await staff.waitForTimeout(1_500);

    const adminStrong = await staff.locator("main strong").count();
    record("admin: le markdown du visiteur est rendu", adminStrong > 0, `<strong> = ${adminStrong}`);

    const adminImage = staff.locator('main img[alt="apple-touch-icon-180x180.png"]').first();
    await adminImage.waitFor({ state: "visible", timeout: 15_000 });
    const adminNatural = await adminImage.evaluate((element) => (element as HTMLImageElement).naturalWidth);
    record("admin: la capture du visiteur s'affiche", adminNatural > 0, `naturalWidth=${adminNatural}`);

    // Le fil prend la hauteur du panneau : ce qui manquait avant ce lot.
    const threadHeight = await staff.locator("[data-slot=message-scroller]").first().evaluate(
      (element) => Math.round(element.getBoundingClientRect().height),
    );
    record(
      "admin: le fil occupe le panneau",
      threadHeight >= 360,
      `${threadHeight}px sur 900 de fenêtre`,
    );

    // Aucun filet horizontal au-dessus du composer : la pilule est le seul trait.
    const composerShell = staff.locator("[data-composer-shell]").first();
    const shellStyle = await composerShell.evaluate((element) => {
      const style = getComputedStyle(element);
      return { radius: style.borderTopLeftRadius, border: style.borderTopWidth };
    });
    record(
      "admin: la saisie est la pilule du composer",
      shellStyle.radius.startsWith("24"),
      `rayon=${shellStyle.radius} trait=${shellStyle.border}`,
    );

    // Répondre, en markdown.
    // Le composer du backoffice est un champ `contentEditable` marqué
    // `[data-composer]`, plus une `textarea`.
    const reply = staff.locator("[data-composer-shell] [data-composer]").first();
    await reply.fill("On a **reproduit** le bug, correctif en route.");
    await staff.locator('[data-composer-action="send"]').click();
    await staff.waitForTimeout(2_000);

    // La bulle, pas le calque de markdown qu'elle contient : `.last()` sur une
    // liste de `div` attrape le plus INTÉRIEUR, qui est transparent. C'est le
    // nœud arrondi qui porte le fond, et c'est lui qu'il faut mesurer.
    const bubble = await staff.locator('main [class*="rounded-2xl"]')
      .filter({ hasText: "correctif en route" })
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    const painted = bubble !== "rgba(0, 0, 0, 0)" && bubble !== "transparent";
    record("admin: la bulle du staff a un fond visible", painted, bubble);
    await shot(staff, "06-fil-staff");

    /* ------------- retour PWA : la pastille, panneau fermé -------------- */

    await page.bringToFront();
    let unread = "0";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      unread = (await page.locator("[data-support-unread]").first().getAttribute("data-support-unread")
        .catch(() => null)) ?? "0";
      if (unread !== "0") break;
      await page.waitForTimeout(500);
    }
    record(
      "pwa: la pastille apparaît hors de la page support",
      unread !== "0",
      `data-support-unread=${unread}`,
    );
    await shot(page, "07-pastille");

    await page.goto(`${WEB}/support`, { waitUntil: "domcontentloaded" });
    await page.locator("text=/correctif en route/").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const answered = await page.locator("text=/correctif en route/").count();
    record("pwa: la réponse du staff est dans le fil", answered > 0, `occurrences=${answered}`);
    await shot(page, "08-fil-repondu");

    /* ------------- `/support/:id` : un lien rouvre CE fil --------------- */

    // L'URL désigne la conversation : un lien collé, un retour arrière ou un
    // e-mail mènent au bon fil, sans passer par une liste.
    // `domcontentloaded` et non `networkidle` : l'app tient des flux SSE
    // ouverts en permanence (le fil du produit, le guichet), donc le réseau
    // n'est JAMAIS au repos et l'attente expirerait à chaque fois.
    await page.goto(`${WEB}/support${conversationId ? `/${conversationId}` : ""}`, { waitUntil: "domcontentloaded" });
    await page.locator("text=/correctif en route/").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    const reopened = await page.locator("text=/correctif en route/").count();
    record(
      "page support: le lien ouvre CE fil",
      reopened > 0,
      `réponse du staff visible, occurrences=${reopened}`,
    );
    await shot(page, "09-page-support");

    // La redirection se joue dans le `beforeLoad` du routeur, donc APRÈS
    // `domcontentloaded`. L'attente doit viser le chemin d'arrivée exact :
    // `/\/support(\/|$)/` reconnaissait déjà `/settings/support` lui-même,
    // rendait la main tout de suite, et la passe lisait l'ancienne adresse
    // avant que la redirection n'ait eu lieu.
    const supportPage = /^(?:\/o\/[^/]+)?\/support(?:\/|$)/u;
    await page.goto(`${WEB}/settings/support`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => supportPage.test(url.pathname), { timeout: 10_000 }).catch(() => {});
    const redirected = supportPage.test(new URL(page.url()).pathname);
    record("réglages: l'ancienne adresse mène à la page support", redirected, page.url());
  } finally {
    /* ------------------ le fil créé est effacé, toujours ---------------- */
    if (conversationId && created) {
      // The staff sign-in above just asked for a code: the API refuses
      // another one for a minute (429 STAFF_LOGIN_CODE_COOLDOWN). Wait it out
      // rather than leave a fake visitor in the real queue.
      const askCode = () => fetch(`${API}/api/pro/staff/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: STAFF_EMAIL }),
      });
      let requested = await askCode();
      for (let attempt = 0; requested.status === 429 && attempt < 4; attempt += 1) {
        await Bun.sleep(20_000);
        requested = await askCode();
      }
      const devCode = ((await requested.json()) as { devCode?: string }).devCode ?? "";
      const login = await fetch(`${API}/api/pro/staff/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: STAFF_EMAIL, code: devCode }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "")
        .split(",")
        .map((part) => part.trim().split(";")[0])
        .filter(Boolean)
        .join("; ");
      const csrf = ((await login.json()) as { csrfToken?: string }).csrfToken ?? "";
      const erased = await fetch(`${API}/api/pro/staff/support/conversations/${conversationId}`, {
        method: "DELETE",
        headers: { Cookie: cookie, "X-CSRF-Token": csrf },
      });
      console.log(
        erased.status === 204
          ? `  fil ${conversationId} effacé`
          : `  ATTENTION : le fil ${conversationId} n'a pas pu être effacé (HTTP ${erased.status})`,
      );
    } else if (conversationId) {
      console.log(`  fil ${conversationId} CONSERVÉ : il appartient au compte, la passe l'a seulement rejoint`);
    }
    await browser?.close();
    writeFileSync(join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications passées. Preuves : ${OUT}`);
  if (failed.length > 0) process.exit(1);
}

await main();
