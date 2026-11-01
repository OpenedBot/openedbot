/**
 * Thread lab playback (dev only): one conversation state shared by the
 * current thread and the prototype, fed by `planLabReply` on real timers.
 */
import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isLabRunLive, planLabReply, type LabRun, type LabScenario, type LabUserInput } from "./thread-lab-script";

export const LAB_MODEL = "lab/demo-model";

type LabState = {
  events: StoredProductEvent[];
  userInputs: LabUserInput[];
  runs: LabRun[];
};

/** The run as the API would return it, for components typed on `RunDto` (`RunActivityDock`). */
function labRunDto(run: LabRun): RunDto {
  return {
    id: run.id,
    status: run.status,
    input: "",
    output: null,
    usage: null,
    error: null,
    hermesResponseId: null,
    model: run.model,
    runtimeSession: null,
    createdAt: run.createdAt,
    startedAt: run.createdAt,
    endedAt: run.endedAt,
    lastEventAt: null,
  };
}

const EMPTY: LabState = { events: [], userInputs: [], runs: [] };

export function useThreadLabPlayback(speed: number) {
  const [state, setState] = useState<LabState>(EMPTY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRun = useRef<string | null>(null);
  const counter = useRef({ turn: 0, cursor: 0, sequence: 0 });
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const finishRun = useCallback((runId: string, status: LabRun["status"]) => {
    const endedAt = new Date().toISOString();
    setState((current) => ({
      ...current,
      runs: current.runs.map((run) => (run.id === runId ? { ...run, status, endedAt } : run)),
    }));
  }, []);

  const append = useCallback((runId: string, type: StoredProductEvent["type"], payload: Record<string, unknown>) => {
    const cursor = ++counter.current.cursor;
    const sequence = ++counter.current.sequence;
    const event: StoredProductEvent = { cursor, sequence, runId, type, payload, occurredAt: new Date() };
    setState((current) => ({ ...current, events: [...current.events, event] }));
  }, []);

  const stop = useCallback(() => {
    const runId = activeRun.current;
    if (!runId) return;
    clearTimer();
    activeRun.current = null;
    // What the worker writes on a cancel (`hermes-events.ts`).
    append(runId, "system.notice", { message: "Mission annulée.", kind: "cancelled" });
    finishRun(runId, "cancelled");
  }, [append, clearTimer, finishRun]);

  const send = useCallback((text: string, scenario: LabScenario) => {
    const trimmed = text.trim();
    if (!trimmed || activeRun.current) return;
    const turn = ++counter.current.turn;
    const runId = `lab-run-${turn}`;
    const createdAt = new Date().toISOString();
    activeRun.current = runId;
    counter.current.sequence = 0;
    setState((current) => ({
      ...current,
      userInputs: [...current.userInputs, { id: `lab-user-${turn}`, text: trimmed, runId, createdAt }],
      runs: [...current.runs, { id: runId, status: "running", model: LAB_MODEL, createdAt, endedAt: null }],
    }));

    const plan = planLabReply(scenario);
    let index = 0;
    const next = () => {
      const step = plan[index];
      if (!step || activeRun.current !== runId) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        if (activeRun.current !== runId) return;
        index += 1;
        append(runId, step.type, step.payload);
        if (step.type === "run.completed" || step.type === "run.error") {
          activeRun.current = null;
          finishRun(runId, step.type === "run.completed" ? "completed" : "failed");
          return;
        }
        next();
      }, step.delayMs / speedRef.current);
    };
    next();
  }, [append, finishRun]);

  const reset = useCallback(() => {
    clearTimer();
    activeRun.current = null;
    setState(EMPTY);
  }, [clearTimer]);

  const running = useMemo(() => state.runs.some((run) => isLabRunLive(run.status)), [state.runs]);

  const runDtos = useMemo(() => state.runs.map(labRunDto), [state.runs]);

  return { ...state, runDtos, running, send, stop, reset };
}
