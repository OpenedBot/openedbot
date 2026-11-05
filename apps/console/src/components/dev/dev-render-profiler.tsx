import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

/**
 * Dev-only React render-cost probe. Wrap a component suspected of
 * causing thread jank: `<DevRenderProfiler id="thread-timeline">...`.
 *
 * In production this renders `children` only (`import.meta.env.DEV === true`,
 * same guard as the rest of the perf HUD, see `docs/cloud/THREAD_PERF_HUD.md`): zero `Profiler` overhead. It never imports `thread-perf-hud.tsx` or
 * `thread-perf-probe.ts` (so wrapping a component doesn't pull the HUD's
 * `react-dom` root or observers into that screen's bundle): every commit is
 * forwarded through `window.__openedbotThreadPerf.recordRender`, a registry the
 * probe installs only when the HUD actually mounts (`?perf=1`). When the HUD
 * isn't enabled, `window.__openedbotThreadPerf` is `undefined` and the optional
 * chain below is a no-op.
 */
export function DevRenderProfiler({ id, children }: { id: string; children: ReactNode }): ReactNode {
  if (import.meta.env.DEV !== true) return children;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

/**
 * The last commits of every profiled subtree, HUD or not: a perf pass reads
 * `window.__openedbotRenderLog` after a refresh to see which subtree cost the first
 * paint. Bounded, development only (this module renders `children` in prod).
 */
const RENDER_LOG_LIMIT = 200;

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, _baseDuration, _startTime, commitTime) => {
  window.__openedbotThreadPerf?.recordRender(id, phase, actualDuration, commitTime);
  const log = (window.__openedbotRenderLog ??= []);
  log.push({ id, phase, actualMs: Math.round(actualDuration * 10) / 10, commitMs: Math.round(commitTime) });
  if (log.length > RENDER_LOG_LIMIT) log.splice(0, log.length - RENDER_LOG_LIMIT);
};

declare global {
  interface Window {
    __openedbotRenderLog?: { id: string; phase: string; actualMs: number; commitMs: number }[];
  }
}
