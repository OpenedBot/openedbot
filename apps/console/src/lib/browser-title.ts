import type { MessageKey } from "@openedbot/browser-i18n";
import { DEVELOPMENT_APP_NAME, PRODUCTION_APP_NAME } from "./app-name";

export const BROWSER_APP_NAME =
  import.meta.env.DEV === true ? DEVELOPMENT_APP_NAME : PRODUCTION_APP_NAME;

const STATIC_TITLE_KEYS: Readonly<Record<string, MessageKey>> = {
  "/": "overviewPlaceholder.nav",
  "/login": "login.title",
  "/onboarding": "onboarding.step_nav.label",
  "/inbox": "inbox.title",
  "/bot": "modeLanding.bot.nav",
  "/settings": "settingsSidebar.overview",
  "/settings/account": "settingsSidebar.account",
  "/settings/runtime": "settingsSidebar.runtime",
  "/settings/agents": "settingsSidebar.agents",
  "/settings/models": "settingsSidebar.models",
  "/settings/appearance": "settingsSidebar.appearance",
  "/settings/archives": "settingsSidebar.archives",
  "/settings/connectors": "settingsSidebar.connectors",
  "/settings/notifications": "settingsSidebar.notifications",
  "/settings/decisions": "settingsSidebar.decisions",
  "/settings/policies": "settingsSidebar.policies",
  "/settings/security": "settingsSidebar.security",
  "/settings/billing": "settingsSidebar.billing",
  "/settings/developer": "settingsSidebar.developer",
  "/legal/mentions": "legal.mentions",
  "/legal/privacy": "legal.privacy",
  "/legal/terms": "legal.terms",
};

export type BrowserTitleEntity = { kind: "bot" | "group"; id: string };

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/u, "");
}

/** Route statique affichée dans l'onglet ; les conversations utilisent leur nom réel. */
export function browserTitleKey(pathname: string): MessageKey | null {
  const path = normalizePathname(pathname);
  if (/^\/c\/[^/]+$/u.test(path)) return "conversation.botGone";
  return STATIC_TITLE_KEYS[path] ?? null;
}

/** Identité encodée dans les routes de conversation, sans deviner un nom depuis l'URL. */
export function browserTitleEntity(pathname: string): BrowserTitleEntity | null {
  const match = normalizePathname(pathname).match(/^\/(bot|g)\/([^/]+)$/u);
  if (!match) return null;
  try {
    return { kind: match[1] === "bot" ? "bot" : "group", id: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

export function formatBrowserTitle(label: string | null | undefined): string {
  const page = label?.trim();
  return page ? `${page} · ${BROWSER_APP_NAME}` : BROWSER_APP_NAME;
}
