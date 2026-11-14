/**
 * Dev-only Chromium pass for PWA ship evidence. Not a product feature.
 * Origin: http://localhost:1420 (Vite). Seed login from E2E_* / seed defaults.
 */
import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMailpitMessageIds, readMailpitLoginCode } from "../../../scripts/lib/password-login";

const ORIGIN = "http://localhost:1420";
const EMAIL = process.env.E2E_EMAIL?.trim() || "dev@openedbot.local";
const PASSWORD = process.env.E2E_PASSWORD || (() => { throw new Error("E2E_PASSWORD is not set: run `make setup` (it generates one in .env.local), or export it."); })();
const OUT = join(import.meta.dir, "../../../tmp/pwa-chromium");

mkdirSync(OUT, { recursive: true });

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

async function shot(page: Page, name: string) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function assertNoFleetCopy(page: Page, name: string) {
  const body = (await page.locator("body").innerText()).toLowerCase();
  const stripped = body.replace(/ce n['’]est pas une flotte|pas une flotte|not a fleet/g, "");
  const fleet = /no gateways|add gateway|\bgateways\b|hermes fleet|\bfleet\b|\bflotte\b/.test(stripped);
  record(name, !fleet, fleet ? `copy interdite: ${body.slice(0, 240)}` : "pas de Fleet / No Gateways");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "fr-FR",
  });
  const page = await context.newPage();

  // ── /login ──
  await page.goto(`${ORIGIN}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2_200);
  const submitVisible = await page.locator("button.lg-submit, button[type='submit']").first().isVisible();
  const bannerOnLogin = await page.locator("[data-slot='pwa-install-notice']").count();
  const loginShot = await shot(page, "01-login");
  record(
    "login: submit visible, pas de bandeau",
    submitVisible && bannerOnLogin === 0,
    `submit=${submitVisible} banner=${bannerOnLogin} ${loginShot}`,
  );

  // ── login seed ──
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
  if (page.url().includes("/onboarding")) {
    record("login: landed", false, `redirigé vers ${page.url()} (onboarding encore ouvert)`);
  } else {
    record("login: landed", true, page.url());
  }

  // ── /  real (seed a un runtime) ──
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2_400);
  const homeShot = await shot(page, "02-home-seed");
  const emptyHeading = await page.getByRole("heading", { name: "Aucun Edge" }).count();
  const bannerAfterLogin = await page.locator("[data-slot='pwa-install-notice']").count();
  record(
    "home seed: pas de bandeau d'installation",
    bannerAfterLogin === 0,
    `banner=${bannerAfterLogin} empty-state=${emptyHeading} ${homeShot}`,
  );
  await assertNoFleetCopy(page, "home seed: copy");

  // ── Réglages → Runtime ──
  await page.getByRole("button", { name: /Dev Owner|@|dev@/i }).first().click().catch(() => {});
  const settingsItem = page.getByRole("menuitem", { name: "Réglages" });
  if (await settingsItem.count()) {
    await settingsItem.click();
  } else {
    await page.goto(`${ORIGIN}/settings`, { waitUntil: "networkidle" });
  }
  await page.waitForTimeout(400);
  await page.getByRole("link", { name: "Edge" }).click();
  await page.waitForURL("**/settings/runtime", { timeout: 8_000 });
  await page.waitForTimeout(600);
  const runtimeShot = await shot(page, "03-settings-runtime");
  const runtimeText = await page.locator("body").innerText();
  const runtimeIntro =
    /Edge/.test(runtimeText) &&
    (/Runtime enregistré/.test(runtimeText) || /Aucun Edge/.test(runtimeText));
  record(
    "settings/runtime",
    runtimeIntro && !/n’est pas administrée par openedbot/.test(runtimeText),
    `${/Runtime enregistré/.test(runtimeText) ? "runtime seed enregistré" : "intro vide"} ${runtimeShot}`,
  );
  await assertNoFleetCopy(page, "settings/runtime: copy");

  // ── Install invitation: the card at the foot of the sidebar ──
  // The « Réglages → Application » screen was removed; the invitation now lives
  // only in the application panel, where it hides nothing. So we have to
  // go back into the `_app` shell: settings mount ANOTHER bar.
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const installCardShot = await shot(page, "04-sidebar-install-card");
  const installCard = await page
    .locator('[data-slot="sidebar"] [role="alert"]')
    .filter({ hasText: /Installer openedbot|Déjà ouverte|Installation indisponible/ })
    .count();
  record(
    "barre latérale : la carte d'installation dit où en est l'installation",
    installCard > 0,
    `cartes=${installCard} ${installCardShot}`,
  );

  // ── empty-state: new context + blocked SW (the seed has a Hermes; we do not revoke it) ──
  const storage = await context.storageState();
  const emptyContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "fr-FR",
    storageState: storage,
    serviceWorkers: "block",
  });
  await emptyContext.route("**/api/runtime", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/runtime") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runtime: null,
        runtimeMode: "external",
        adminMode: "cloud",
        devDefaults: null,
      }),
    });
  });
  const empty = await emptyContext.newPage();
  await empty.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  await empty.waitForTimeout(2_400);
  const emptyShot = await shot(empty, "05-home-empty-intercept");
  const salonTitle = await empty.getByRole("heading", { name: "Le salon est calme." }).count();
  const salonLink = empty.getByRole("link", { name: /Ouvrir l.inbox/ });
  const salonHref = (await salonLink.count()) ? await salonLink.getAttribute("href") : null;
  const emptyBanner = await empty.locator("[data-slot='pwa-install-notice']").count();
  record(
    "home foyer (GET /api/runtime intercepté)",
    salonTitle > 0 && salonHref === "/inbox" && emptyBanner === 0,
    `heading=${salonTitle} href=${salonHref} banner=${emptyBanner} ${emptyShot}`,
  );
  await assertNoFleetCopy(empty, "home empty-state: copy");

  await empty.goto(`${ORIGIN}/settings/runtime`, { waitUntil: "networkidle" });
  await empty.waitForTimeout(600);
  const emptyRuntimeShot = await shot(empty, "06-settings-runtime-empty-intercept");
  const emptyRuntimeText = await empty.locator("body").innerText();
  record(
    "settings/runtime empty intro (intercept)",
    /Aucun Edge/.test(emptyRuntimeText) && /pas une flotte/.test(emptyRuntimeText),
    emptyRuntimeShot,
  );

  await emptyContext.close();
  await browser.close();

  const failed = results.filter((row) => !row.ok);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ origin: ORIGIN, results, failed: failed.length }, null, 2));
  if (failed.length) {
    console.error(`\n${failed.length} assertion(s) failed. Evidence: ${OUT}`);
    process.exit(1);
  }
  console.log(`\nAll assertions passed. Evidence: ${OUT}`);
}

await main();
