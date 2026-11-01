/**
 * The pro console modules this build carries, and the gate of each feature:
 * its module is present AND the session holds its entitlement.
 *
 * Solo (`OHB_PRO_CONSOLE` empty), `virtual:ohb-pro-console` is an empty list:
 * every feature reads `undefined`, so no route, nav entry or card exists and
 * no pro endpoint is ever called.
 */
import { useQuery } from "@tanstack/react-query";
import proConsoleModules from "virtual:ohb-pro-console";
import { api, queryKeys } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { PRO_CONSOLE_ENTITLEMENTS, type ProConsoleFeature, type ProConsoleFeatures, type ProConsoleModule } from "./contract";

let features: ProConsoleFeatures | null = null;
let modules: readonly ProConsoleModule[] | null = null;

function collect(modules: readonly ProConsoleModule[]): ProConsoleFeatures {
  const out: ProConsoleFeatures = {};
  for (const module of modules) {
    for (const feature of Object.keys(PRO_CONSOLE_ENTITLEMENTS) as ProConsoleFeature[]) {
      const slots = module[feature];
      if (!slots) continue;
      if (slots.entitlement !== PRO_CONSOLE_ENTITLEMENTS[feature]) {
        throw new Error(`pro console module "${module.id}": ${feature} must declare the entitlement "${PRO_CONSOLE_ENTITLEMENTS[feature]}"`);
      }
      if (out[feature]) throw new Error(`pro console module "${module.id}": ${feature} is already provided`);
      (out as Record<ProConsoleFeature, unknown>)[feature] = slots;
    }
  }
  return out;
}

/** What the build carries. Read lazily: modules may still evaluate when a caller loads. */
export function proConsole(): ProConsoleFeatures {
  features ??= collect(loadedModules());
  return features;
}

function loadedModules(): readonly ProConsoleModule[] {
  modules ??= proConsoleModules();
  return modules;
}

/**
 * Where an address a pro module published before now lives (`legacyHref`),
 * or `null`. The first module that knows it answers; a module that throws
 * answers nothing.
 */
export function proLegacyHref(url: URL): string | null {
  for (const module of loadedModules()) {
    try {
      const next = module.legacyHref?.(url) ?? null;
      if (next && next !== `${url.pathname}${url.search}${url.hash}`) return next;
    } catch {
      // An old address that cannot be mapped is not found, never a broken page.
    }
  }
  return null;
}

/** Tests only: install other modules (a solo build, a pro build). */
export function setProConsoleModulesForTest(next: readonly ProConsoleModule[] | null): void {
  features = next === null ? null : collect(next);
  modules = next;
}

export function hasEntitlement(entitlements: readonly string[] | undefined, feature: ProConsoleFeature): boolean {
  return entitlements?.includes(PRO_CONSOLE_ENTITLEMENTS[feature]) === true;
}

/**
 * The feature's slots when the build carries it and the session holds its
 * entitlement, otherwise `undefined`. A build without the module never reads
 * `/api/auth/me` here: the choice is fixed for the life of the page, so the
 * hook order is too.
 */
export function useProFeature<F extends ProConsoleFeature>(feature: F): ProConsoleFeatures[F] | undefined {
  const slots = proConsole()[feature];
  return slots ? useEntitledSlots(slots, feature) : undefined;
}

function useEntitledSlots<S>(slots: S, feature: ProConsoleFeature): S | undefined {
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe, refetchOnMount: false });
  return hasEntitlement(me.data?.entitlements, feature) ? slots : undefined;
}

/** For route guards: the same gate, read from the session cache. */
export async function proFeatureEntitled(feature: ProConsoleFeature): Promise<boolean> {
  if (!proConsole()[feature]) return false;
  const me = await queryClient.ensureQueryData({ queryKey: queryKeys.authMe, queryFn: api.authMe }).catch(() => null);
  return hasEntitlement(me?.entitlements, feature);
}
