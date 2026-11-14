import { describe, expect, test } from "bun:test";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import {
  matchesThreadFilter,
  readThreadFilter,
  serializeCursor,
  SSE_MAX_THREAD_FILTER,
} from "../src/routes/events/event-routes";
import { HttpError } from "../src/interfaces/http/http-error";
import { frameReader, sseTestApp, storedRow, streamEvent } from "./fixtures/event-stream";
import { fakeRunEventsDb } from "./fixtures/run-events-db";

const threadA = "0b6f1d2e-0000-4000-8000-00000000000a";
const threadB = "0b6f1d2e-0000-4000-8000-00000000000b";
const threadC = "0b6f1d2e-0000-4000-8000-00000000000c";

const armed = () => Bun.sleep(20);

describe("flux SSE filtré par fil", () => {
  test("le live ne rend que les fils demandés et les événements d'organisation ; sans filtre, tout passe", async () => {
    const organizationId = "org-filter-live";
    const hub = new EventHub();
    const app = sseTestApp(organizationId, fakeRunEventsDb([]), hub);
    const filtered = frameReader((await app.request(`http://localhost/?cursor=0&threadId=${threadA}&threadId=${threadC}`)).body!);
    const whole = frameReader((await app.request("http://localhost/?cursor=0")).body!);
    await armed();

    hub.publish(streamEvent(organizationId, 1, threadA));
    hub.publish(streamEvent(organizationId, 2, threadB));
    hub.publish(streamEvent(organizationId, 3, null));
    hub.publish(streamEvent(organizationId, 4, threadB));
    hub.publish(streamEvent(organizationId, 5, threadC));

    const filteredFrames = (await filtered.next(3)).frames;
    const wholeFrames = (await whole.next(5)).frames;
    await filtered.cancel();
    await whole.cancel();

    expect(filteredFrames.map((frame) => [frame.id, JSON.parse(frame.data).threadId])).toEqual([
      ["1", threadA], ["3", null], ["5", threadC],
    ]);
    expect(wholeFrames.map((frame) => frame.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  test("le rejeu est filtré, puis stream.cursor avance la reprise au-delà de ce qui a été écarté", async () => {
    const organizationId = "org-filter-replay";
    const rows = [
      storedRow(organizationId, 1, threadA),
      storedRow(organizationId, 2, threadB),
      storedRow(organizationId, 3, threadA),
      storedRow(organizationId, 4, threadB),
    ];
    const app = sseTestApp(organizationId, fakeRunEventsDb(rows), new EventHub());
    const reader = frameReader((await app.request(`http://localhost/?cursor=0&threadId=${threadA.toUpperCase()}`)).body!);
    const { frames } = await reader.next(3);
    await reader.cancel();

    expect(frames.map((frame) => [frame.event, frame.id])).toEqual([
      ["agent.message", "1"], ["agent.message", "3"], ["stream.cursor", "4"],
    ]);
    expect(JSON.parse(frames[2]!.data)).toEqual({ organizationId, cursor: 4 });
  });

  test("en live, stream.cursor part dès que l'écart atteint la moitié de la fenêtre de rejeu", async () => {
    const organizationId = "org-filter-live-advance";
    const hub = new EventHub();
    // Window of 10: advances at the 5th skipped cursor, not before.
    const app = sseTestApp(organizationId, fakeRunEventsDb([]), hub, 10);
    const reader = frameReader((await app.request(`http://localhost/?cursor=0&threadId=${threadA}`)).body!);
    await armed();
    for (let cursor = 1; cursor <= 7; cursor += 1) hub.publish(streamEvent(organizationId, cursor, threadB));
    hub.publish(streamEvent(organizationId, 8, threadA));
    const { frames } = await reader.next(2);
    await reader.cancel();
    expect(frames.map((frame) => [frame.event, frame.id])).toEqual([["stream.cursor", "5"], ["agent.message", "8"]]);
  });

  test("pas de stream.cursor quand rien d'écarté ne dépasse le dernier événement rendu", async () => {
    const organizationId = "org-filter-no-advance";
    const rows = [storedRow(organizationId, 1, threadB), storedRow(organizationId, 2, threadA)];
    const hub = new EventHub();
    const app = sseTestApp(organizationId, fakeRunEventsDb(rows), hub);
    const reader = frameReader((await app.request(`http://localhost/?cursor=0&threadId=${threadA}`)).body!);
    await armed();
    hub.publish(streamEvent(organizationId, 3, threadA));
    const { frames } = await reader.next(2);
    await reader.cancel();
    expect(frames.map((frame) => [frame.event, frame.id])).toEqual([["agent.message", "2"], ["agent.message", "3"]]);
  });

  test("le filtre se lit en UUID répétés, normalisés, et refuse le reste", () => {
    expect(readThreadFilter(undefined)).toBeNull();
    expect(readThreadFilter([])).toBeNull();
    expect(readThreadFilter([threadA.toUpperCase(), threadA, threadB])).toEqual(new Set([threadA, threadB]));
    const refused = (values: string[]) => {
      try {
        readThreadFilter(values);
      } catch (error) {
        return error instanceof HttpError ? [error.status, error.code] : error;
      }
      return null;
    };
    expect(refused(["thread-1"])).toEqual([400, "THREAD_FILTER_INVALID"]);
    expect(refused([""])).toEqual([400, "THREAD_FILTER_INVALID"]);
    expect(refused(Array.from({ length: SSE_MAX_THREAD_FILTER + 1 }, () => threadA))).toEqual([400, "THREAD_FILTER_INVALID"]);
  });

  test("un événement d'organisation passe tout filtre ; sans filtre, tout passe", () => {
    const filter = new Set([threadA]);
    expect(matchesThreadFilter(filter, streamEvent("org", 1, null))).toBe(true);
    expect(matchesThreadFilter(filter, streamEvent("org", 1, threadA))).toBe(true);
    expect(matchesThreadFilter(filter, streamEvent("org", 1, threadB))).toBe(false);
    expect(matchesThreadFilter(null, streamEvent("org", 1, threadB))).toBe(true);
  });

  test("stream.cursor porte id: et le curseur, comme un événement sans contenu", () => {
    expect(serializeCursor({ organizationId: "org-1", cursor: 42 }))
      .toBe('id: 42\nevent: stream.cursor\ndata: {"organizationId":"org-1","cursor":42}\n\n');
  });
});
