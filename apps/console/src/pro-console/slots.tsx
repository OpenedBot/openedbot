/**
 * The places where the core console shows a pro feature, each with its solo
 * fallback. Core code imports these, never a pro screen (`make solo-check`,
 * rule `console-no-pro-screens` of `.dependency-cruiser.cjs`).
 *
 * Which branch runs is fixed by the build (`proConsole()` never changes during
 * a page's life), so a hook wrapper keeps a stable hook order.
 */
import { Suspense, type ComponentProps, type ReactNode } from "react";
import type { BotDto } from "@openedbot/contracts-api";
import type { FleetConsole } from "./contract";
import { proConsole, useProFeature } from "./registry";

type Frame = FleetConsole["frame"];
type Journal = FleetConsole["journal"];

const fleet = () => proConsole().fleet;

// ── Fleet (gate: module present; its hooks read `agencyAvailable`) ──────────

export function hasFleetConsole(): boolean {
  return fleet() !== undefined;
}

export function useFleetFrameContext(): ReturnType<Frame["useFleetFrameContext"]> {
  const slots = fleet();
  return slots ? slots.frame.useFleetFrameContext() : null;
}

/** Solo, every path is the workspace's own (`/conversations` is the default section). */
export function fleetSectionOf(pathname: string): ReturnType<Frame["fleetSectionOf"]> {
  const slots = fleet();
  return slots ? slots.frame.fleetSectionOf(pathname) : "/conversations";
}

/** Solo, no organization is a fleet the frame could draw while it loads. */
export function activeOwnFleetHint(): boolean {
  return fleet()?.frame.activeOwnFleetHint() === true;
}

export function FleetRail(props: ComponentProps<Frame["FleetRail"]>) {
  const Slot = fleet()?.frame.FleetRail;
  return Slot ? <Slot {...props} /> : null;
}

export function FleetTopBar(props: ComponentProps<Frame["FleetTopBar"]>) {
  const Slot = fleet()?.frame.FleetTopBar;
  return Slot ? <Slot {...props} /> : null;
}

export function FleetClientFrame(props: ComponentProps<Frame["FleetClientFrame"]>) {
  const Slot = fleet()?.frame.FleetClientFrame;
  return Slot ? <Slot {...props} /> : <>{props.children}</>;
}

export function FleetClientLoading(props: ComponentProps<Frame["FleetClientLoading"]>) {
  const Slot = fleet()?.frame.FleetClientLoading;
  return Slot ? <Slot {...props} /> : <>{props.fallback}</>;
}

export function FleetClientSettingsContext({ children }: { children: ReactNode }) {
  const Slot = fleet()?.frame.FleetClientSettingsContext;
  return Slot ? <Slot>{children}</Slot> : <>{children}</>;
}

export function FleetA2APolicySettings(props: ComponentProps<Journal["FleetA2APolicySettings"]>) {
  const Slot = fleet()?.journal.FleetA2APolicySettings;
  return Slot ? <Slot {...props} /> : null;
}

export function FleetClientAudit(props: ComponentProps<Journal["FleetClientAudit"]>) {
  const Slot = fleet()?.journal.FleetClientAudit;
  return Slot ? <Slot {...props} /> : null;
}

export function useFleetAuditScope(): ReturnType<Journal["useFleetAuditScope"]> {
  const slots = fleet();
  return slots ? slots.journal.useFleetAuditScope() : null;
}

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

