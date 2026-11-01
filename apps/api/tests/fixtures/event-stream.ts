import { Hono } from "hono";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import type { EventHub } from "@openedbot/notifications/application/event-hub";
import type { Db } from "@openedbot/platform-db";
import { eventRoutes } from "../../src/routes/events/event-routes";
import type { AppVariables } from "../../src/routes/identity/auth";
import type { StoredRow } from "./run-events-db";

export type Frame = { id: string | null; event: string | null; data: string; bytes: number };

const occurredAt = new Date("2026-10-03T12:00:00.000Z");

/** Un `agent.message` tel que le publie le poller. */
export function streamEvent(organizationId: string, cursor: number, threadId: string | null, delta = "x"): OrganizationEvent {
  return {
    version: 1, cursor, organizationId, threadId, runId: "run-1", botId: null, turnId: null,
    sessionKey: null, leaseGeneration: null, sequence: cursor, type: "agent.message",
    payload: { delta }, occurredAt: occurredAt.toISOString(),
  };
}

/** La même ligne, telle que le rejeu la lit. */
export function storedRow(organizationId: string, cursor: number, threadId: string, delta = "x"): StoredRow {
  return {
    cursor: String(cursor), organizationId, threadId, runId: "run-1", botId: null, turnId: null,
    sessionKey: null, leaseGeneration: null, sequence: cursor, type: "agent.message", payload: { delta }, occurredAt,
  };
}

export function sseTestApp(organizationId: string, db: Db, hub: EventHub, replayWindowEvents = 1_000) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(async (context, next) => {
    context.set("auth", { organizationId } as AppVariables["auth"]);
    await next();
  });
  app.route("/", eventRoutes(db, hub, { fallbackPollMs: 60_000, replayWindowMs: 3_600_000, replayWindowEvents }));
  return app;
}

/** Lecteur de trames à état : `next(count)` lit jusqu'à `count` trames de données ou la fin du flux. */
export function frameReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let done = false;
  return {
    async next(count = Number.POSITIVE_INFINITY): Promise<{ frames: Frame[]; done: boolean }> {
      const frames: Frame[] = [];
      for (;;) {
        let end = text.indexOf("\n\n");
        while (end >= 0 && frames.length < count) {
          const raw = text.slice(0, end);
          text = text.slice(end + 2);
          end = text.indexOf("\n\n");
          const lines = raw.split("\n");
          const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
          const data = field("data");
          if (data !== null) frames.push({ id: field("id"), event: field("event"), data, bytes: raw.length + 2 });
        }
        if (frames.length >= count || done) return { frames, done };
        const chunk = await reader.read();
        if (chunk.done) done = true;
        else text += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}
