/**
 * The places where the core console shows a pro feature, each with its solo
 * fallback. Core code imports these, never a pro screen (`make solo-check`,
 * rule `console-no-pro-screens` of `.dependency-cruiser.cjs`).
 *
 * Which branch runs is fixed by the build (`proConsole()` never changes during
 * a page's life), so a hook wrapper keeps a stable hook order.
 */
import { Suspense } from "react";
import type { BotDto } from "@openedbot/contracts-api";
import { useProFeature } from "./registry";

// ── Permission rules (gate: module + `permissions.rules`) ────────────────────

/** True when the pro permission screens exist; core code shows its advanced review disclosure on it. */
export function useHasProPermissions(): boolean {
  return Boolean(useProFeature("permissions"));
}

export function BotPermissionRules({ bot }: { bot: BotDto }) {
  const slots = useProFeature("permissions");
  if (!slots) return null;
  return <Suspense fallback={null}><slots.BotPermissionRules bot={bot} /></Suspense>;
}

export function OrganizationPermissionRulesSettings() {
  const slots = useProFeature("permissions");
  if (!slots) return null;
  return <Suspense fallback={null}><slots.OrganizationPermissionRulesSettings /></Suspense>;
}

