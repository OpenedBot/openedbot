import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import { BUTTON } from "../settings/primitives";
import {
  installThreadPerfProbe,
  type LongFrame,
  type RenderSample,
  type ThreadPerfProbe,
  type ThreadPerfSnapshot,
} from "../../lib/dev/thread-perf-probe";
import "../../styles/components/thread-perf-hud.css";

/**
 * Dev-only perf HUD for the conversation thread. See
 * `docs/cloud/THREAD_PERF_HUD.md` for the budgets and
 * how to enable it (`?perf=1`). `mountThreadPerfHud` is the only export
 * meant to be called (from `main.tsx`, inside an `import.meta.env.DEV`
 * dynamic-import branch so this whole module is tree-shaken out of a
 * production build).
 */

const STORAGE_KEY = "openedbot.dev.threadPerf";
const CONTEXT_REFRESH_MS = 1_000;

function readPerfQueryParam(): "1" | "0" | null {
  const value = new URLSearchParams(location.search).get("perf");
  return value === "1" || value === "0" ? value : null;
}

/** Resolves whether the HUD should mount, applying the `?perf=` opt-in/out to localStorage. */
function resolveEnabled(): boolean {
  const param = readPerfQueryParam();
  if (param === "1") {
    localStorage.setItem(STORAGE_KEY, "1");
    return true;
  }
  if (param === "0") {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  return localStorage.getItem(STORAGE_KEY) === "1";
}

const COLLAPSED_KEY = "openedbot.dev.threadPerf.collapsed";
const POSITION_KEY = "openedbot.dev.threadPerf.position";
/** Below the conversation header, clear of the composer and its Send button. */
const DEFAULT_TOP = 64;
const EDGE = 8;
/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

export type HudPosition = { left: number; top: number };

/** Keeps the panel's header reachable whatever the window size. */
export function clampHudPosition(position: HudPosition, size: { width: number; height: number }, viewport: { width: number; height: number }): HudPosition {
  return {
    left: Math.min(Math.max(EDGE, position.left), Math.max(EDGE, viewport.width - size.width - EDGE)),
    top: Math.min(Math.max(EDGE, position.top), Math.max(EDGE, viewport.height - 40)),
  };
}

function readStoredPosition(): HudPosition | null {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null") as unknown;
    if (value && typeof value === "object" && Number.isFinite((value as HudPosition).left) && Number.isFinite((value as HudPosition).top)) return value as HudPosition;
  } catch {
    // An unreadable value falls back to the default corner.
  }
  return null;
}

/**
 * Where the panel sits: top right under the header by default (bottom right
 * covered the composer and Send), movable by dragging it from anywhere, and both
 * the place and the collapsed state survive a reload.
 */
function useHudPlacement() {
  const panel = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsedState] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const [position, setPosition] = useState<HudPosition | null>(readStoredPosition);
  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    if (next) localStorage.setItem(COLLAPSED_KEY, "1");
    else localStorage.removeItem(COLLAPSED_KEY);
  }, []);
  const clampToWindow = useCallback((next: HudPosition) => {
    const rect = panel.current?.getBoundingClientRect();
    return clampHudPosition(next, { width: rect?.width ?? 0, height: rect?.height ?? 0 }, { width: window.innerWidth, height: window.innerHeight });
  }, []);
  useEffect(() => {
    if (!position) return;
    const onResize = () => setPosition((current) => (current ? clampToWindow(current) : current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [position, clampToWindow]);
  /**
   * Drags from anywhere on the panel (not only its header), once the pointer
   * has moved a few pixels: a plain click still reaches the buttons, and the
   * body's scrollbar still scrolls.
   */
  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest("button")) return;
    if (target.scrollHeight > target.clientHeight && event.nativeEvent.offsetX >= target.clientWidth) return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const offset = { x: startX - rect.left, y: startY - rect.top };
    let last: HudPosition | null = null;
    const onMove = (move: PointerEvent) => {
      if (!last && Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD) return;
      if (!last) document.body.style.userSelect = "none";
      last = clampToWindow({ left: move.clientX - offset.x, top: move.clientY - offset.y });
      setPosition(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!last) return;
      document.body.style.userSelect = "";
      localStorage.setItem(POSITION_KEY, JSON.stringify(last));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const resetPosition = () => {
    localStorage.removeItem(POSITION_KEY);
    setPosition(null);
  };
  const style = position ? { left: position.left, top: position.top } : { right: EDGE, top: DEFAULT_TOP };
  return { panel, collapsed, setCollapsed, style, onDragStart, resetPosition };
}

function msFmt(value: number): string {
  return `${value.toFixed(1)} ms`;
}

type Tone = "pass" | "warn" | "fail" | "muted";

function toneForBudget(value: number, budget: number): Tone {
  if (value <= budget) return "pass";
  if (value <= budget * 1.5) return "warn";
  return "fail";
}

function toneClass(tone: Tone): string {
  switch (tone) {
    case "pass":
      return "openedbot-thread-perf-hud-pass";
    case "warn":
      return "openedbot-thread-perf-hud-warn";
    case "fail":
      return "openedbot-thread-perf-hud-fail";
    default:
      return "openedbot-thread-perf-hud-muted";
  }
}

function LongFrameList({ frames, budgetMs }: { frames: LongFrame[]; budgetMs: number }) {
  if (frames.length === 0) {
    return <div className="openedbot-thread-perf-hud-muted">no long frame</div>;
  }
  return (
    <div>
      {frames.map((frame, index) => (
        // eslint-disable-next-line react/no-array-index-key -- frames have no stable id
        <div key={index}>
          <span className={toneClass(toneForBudget(frame.duration, budgetMs))}>
            {msFmt(frame.duration)}
          </span>
          {" blocking="}
          {msFmt(frame.blockingDuration)}
          {" style+layout="}
          {msFmt(frame.styleAndLayoutMs)}
          {" paint~="}
          {msFmt(frame.paintMs)}
          {frame.scripts.map((script, scriptIndex) => (
            <div
              className="openedbot-thread-perf-hud-script"
              // eslint-disable-next-line react/no-array-index-key -- scripts have no stable id
              key={scriptIndex}
            >
              {script.invoker ?? script.sourceFunctionName ?? "(anonymous)"}
              {script.sourceFile ? ` @ ${script.sourceFile}` : ""}
              {" - "}
              {msFmt(script.duration)}
              {script.forcedStyleAndLayoutDuration > 0
                ? ` (forced layout ${msFmt(script.forcedStyleAndLayoutDuration)})`
                : ""}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RenderList({ renders }: { renders: RenderSample[] }) {
  if (renders.length === 0) {
    return <div className="openedbot-thread-perf-hud-muted">no render recorded (wrap a component in DevRenderProfiler)</div>;
  }
  return (
    <div>
      {renders.slice(0, 3).map((render, index) => (
        // eslint-disable-next-line react/no-array-index-key -- renders have no stable id
        <div key={index} className="openedbot-thread-perf-hud-row">
          <span>
            {render.id} ({render.phase})
          </span>
          <span>{msFmt(render.actualMs)}</span>
        </div>
      ))}
    </div>
  );
}

function RunMarkRow({ label, value, budget }: { label: string; value: number | null; budget: number | null }) {
  const tone: Tone = value === null || budget === null ? "muted" : toneForBudget(value, budget);
  return (
    <div className="openedbot-thread-perf-hud-row">
      <span>
        {label}
        {budget === null ? "" : ` (${budget} ms)`}
      </span>
      <span className={toneClass(tone)}>{value === null ? "pending..." : msFmt(value)}</span>
    </div>
  );
}

function ThreadPerfPanel({ probe }: { probe: ThreadPerfProbe }) {
  const [snapshot, setSnapshot] = useState<ThreadPerfSnapshot>(() => probe.getSnapshot());
  const { panel, collapsed, setCollapsed, style, onDragStart, resetPosition } = useHudPlacement();

  useEffect(() => probe.subscribe(() => setSnapshot(probe.getSnapshot())), [probe]);

  useEffect(() => {
    if (collapsed) return;
    probe.refreshContext();
    const interval = setInterval(() => probe.refreshContext(), CONTEXT_REFRESH_MS);
    return () => clearInterval(interval);
  }, [probe, collapsed]);

  const lastSend = snapshot.samples.at(-1);
  const lastTyping = snapshot.typing.at(-1);
  const lastStreaming = snapshot.streaming.at(-1);

  const summaryTone = useMemo<Tone>(() => {
    if (!lastSend || lastSend.pass === null) return "muted";
    if (!lastSend.pass || !lastSend.longFramesPass) return "fail";
    return "pass";
  }, [lastSend]);

  return (
    <div ref={panel} className="openedbot-thread-perf-hud" style={style} onPointerDown={onDragStart}>
      <div className="openedbot-thread-perf-hud-header" onDoubleClick={resetPosition} title="Drag the panel to move it, double-click here to put it back">
        <span className={toneClass(summaryTone)}>
          thread perf
          {collapsed && lastSend ? (
            <span className="openedbot-thread-perf-hud-summary">
              {" "}
              {lastSend.latencyMs === null ? "..." : msFmt(lastSend.latencyMs)}
              {" / text "}
              {lastSend.run.firstTextMs === null ? "..." : msFmt(lastSend.run.firstTextMs)}
            </span>
          ) : null}
        </span>
        <span style={{ display: "flex", gap: 4 }}>
          <button type="button" className={BUTTON.small} onClick={() => probe.reset()}>
            reset
          </button>
          <button type="button" className={BUTTON.small} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? "expand" : "collapse"}
          </button>
        </span>
      </div>
      {collapsed ? null : (
        <div className="openedbot-thread-perf-hud-body">
          <div className="openedbot-thread-perf-hud-section">
            <div className="openedbot-thread-perf-hud-title">send latency (budget {snapshot.budgets.sendLatencyMs} ms)</div>
            {lastSend ? (
              <>
                <div className="openedbot-thread-perf-hud-row">
                  <span>latency</span>
                  <span
                    className={toneClass(
                      lastSend.latencyMs === null
                        ? "muted"
                        : toneForBudget(lastSend.latencyMs, snapshot.budgets.sendLatencyMs),
                    )}
                  >
                    {lastSend.latencyMs === null ? "pending..." : msFmt(lastSend.latencyMs)}
                  </span>
                </div>
                <div className="openedbot-thread-perf-hud-row openedbot-thread-perf-hud-muted">
                  <span>composer emptied</span>
                  <span>{lastSend.composerEmptiedMs === null ? "pending..." : msFmt(lastSend.composerEmptiedMs)}</span>
                </div>
                <div className="openedbot-thread-perf-hud-row openedbot-thread-perf-hud-muted">
                  <span>bubble painted</span>
                  <span>{lastSend.bubblePaintedMs === null ? "pending..." : msFmt(lastSend.bubblePaintedMs)}</span>
                </div>
                <LongFrameList frames={lastSend.longFrames} budgetMs={snapshot.budgets.longFrameMs} />
                <RenderList renders={lastSend.renders} />
              </>
            ) : (
              <div className="openedbot-thread-perf-hud-muted">no send observed yet</div>
            )}
          </div>

          <div className="openedbot-thread-perf-hud-section">
            <div className="openedbot-thread-perf-hud-title">run latency (from send)</div>
            {lastSend ? (
              <>
                <RunMarkRow label="api accepted" value={lastSend.run.acceptedMs} budget={snapshot.budgets.acceptedMs} />
                <RunMarkRow
                  label="first runtime event"
                  value={lastSend.run.firstEventMs}
                  budget={snapshot.budgets.firstEventMs}
                />
                <RunMarkRow label="first text" value={lastSend.run.firstTextMs} budget={snapshot.budgets.firstTextMs} />
                <RunMarkRow label="full reply" value={lastSend.run.completedMs} budget={null} />
              </>
            ) : (
              <div className="openedbot-thread-perf-hud-muted">no send observed yet</div>
            )}
          </div>

          <div className="openedbot-thread-perf-hud-section">
            <div className="openedbot-thread-perf-hud-title">typing (budget {snapshot.budgets.typingMutations} mutation)</div>
            {lastTyping ? (
              <>
                <div className="openedbot-thread-perf-hud-row">
                  <span>mutations</span>
                  <span className={toneClass(lastTyping.mutations <= snapshot.budgets.typingMutations ? "pass" : "fail")}>
                    {lastTyping.mutations}
                  </span>
                </div>
                <LongFrameList frames={lastTyping.longFrames} budgetMs={snapshot.budgets.longFrameMs} />
              </>
            ) : (
              <div className="openedbot-thread-perf-hud-muted">no typing window closed yet</div>
            )}
          </div>

          <div className="openedbot-thread-perf-hud-section">
            <div className="openedbot-thread-perf-hud-title">streaming (budget {snapshot.budgets.streamingFrameMs} ms)</div>
            {lastStreaming ? (
              <>
                <div className="openedbot-thread-perf-hud-row">
                  <span>worst / p95</span>
                  <span className={toneClass(toneForBudget(lastStreaming.worstMs, snapshot.budgets.streamingFrameMs))}>
                    {msFmt(lastStreaming.worstMs)} / {msFmt(lastStreaming.p95Ms)}
                  </span>
                </div>
                <div className="openedbot-thread-perf-hud-muted">{lastStreaming.sampleCount} long frames in window</div>
                <RenderList renders={lastStreaming.renders} />
              </>
            ) : (
              <div className="openedbot-thread-perf-hud-muted">no streaming window observed yet</div>
            )}
          </div>

          <div className="openedbot-thread-perf-hud-section">
            <div className="openedbot-thread-perf-hud-title">context</div>
            <div className="openedbot-thread-perf-hud-row">
              <span>thread nodes</span>
              <span>{snapshot.context.threadNodeCount ?? "-"}</span>
            </div>
            <div className="openedbot-thread-perf-hud-row">
              <span>document nodes</span>
              <span>{snapshot.context.documentNodeCount ?? "-"}</span>
            </div>
            <div className="openedbot-thread-perf-hud-row">
              <span>turns mounted</span>
              <span>{snapshot.context.turnsMounted ?? "-"}</span>
            </div>
            {!snapshot.supportsLongAnimationFrame ? (
              <div className="openedbot-thread-perf-hud-warn">
                long-animation-frame unsupported, falling back to longtask (no script attribution)
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Mounts the HUD in its own root appended to `document.body`, outside
 * `[data-thread-messages]` so it never enters the thread's find/anchor
 * logic. No-op (and never mounts a DOM node) when `?perf=1` was not set
 * this session or in a previous one (`localStorage["openedbot.dev.threadPerf"]`).
 */
export function mountThreadPerfHud(): void {
  if (typeof window === "undefined") return;
  if (!resolveEnabled()) return;

  const probe = installThreadPerfProbe(window);
  const container = document.createElement("div");
  container.id = "openedbot-thread-perf-hud-root";
  document.body.appendChild(container);
  createRoot(container).render(<ThreadPerfPanel probe={probe} />);
}
