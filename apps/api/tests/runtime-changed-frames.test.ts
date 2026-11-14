import { describe, expect, test } from "bun:test";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { mergeRuntimeChangedFrames, readRuntimeChangedFrame } from "@openedbot/contracts-events";
import { createRuntimeChangedWriter, serializeRuntimeChanged } from "../src/routes/events/sse-frames";

/** Rework-flux-api step 5a: the `runtime.changed` control frame. */
describe("runtime.changed control frame", () => {
  test("serialized without id nor organizationId: no resume cursor moves, older clients drop it", () => {
    const frame = serializeRuntimeChanged({ runtimeId: "rt-1", reason: "changed" });
    expect(frame).toBe('event: runtime.changed\ndata: {"runtimeId":"rt-1","reason":"changed"}\n\n');
    expect(frame).not.toContain("id:");
    // The pre-5a client loop: `if (event.organizationId !== organizationId) continue;`.
    const data = JSON.parse(frame.split("data: ")[1]!) as { organizationId?: string };
    expect(data.organizationId).toBeUndefined();
  });

  test("the reader accepts only the declared shape", () => {
    expect(readRuntimeChangedFrame({ runtimeId: null, reason: "resync" })).toEqual({ runtimeId: null, reason: "resync" });
    expect(readRuntimeChangedFrame({ runtimeId: 7, reason: "changed" })).toBeNull();
    expect(readRuntimeChangedFrame({ runtimeId: "rt", reason: "other" })).toBeNull();
    expect(readRuntimeChangedFrame("runtime.changed")).toBeNull();
  });

  test("pending frames merge: one runtime keeps its id, two do not, a resync wins", () => {
    const one = { runtimeId: "rt-1", reason: "changed" } as const;
    expect(mergeRuntimeChangedFrames(null, one)).toEqual(one);
    expect(mergeRuntimeChangedFrames(one, one)).toEqual(one);
    expect(mergeRuntimeChangedFrames(one, { runtimeId: "rt-2", reason: "changed" })).toEqual({ runtimeId: null, reason: "changed" });
    expect(mergeRuntimeChangedFrames(one, { runtimeId: null, reason: "resync" })).toEqual({ runtimeId: null, reason: "resync" });
  });

  test("a frame that cannot be written now is kept, merged, and written once the connection can", () => {
    const written: string[] = [];
    let open = false;
    const writer = createRuntimeChangedWriter({ write: (frame) => written.push(frame), canWrite: () => open });
    writer.offer({ runtimeId: "rt-1", reason: "changed" });
    writer.offer({ runtimeId: "rt-2", reason: "changed" });
    expect(written).toEqual([]);
    expect(writer.flush()).toBe(false);
    open = true;
    expect(writer.flush()).toBe(true);
    expect(written).toEqual([serializeRuntimeChanged({ runtimeId: null, reason: "changed" })]);
    expect(writer.flush()).toBe(false);
    writer.offer({ runtimeId: "rt-3", reason: "changed" });
    expect(written.at(-1)).toBe(serializeRuntimeChanged({ runtimeId: "rt-3", reason: "changed" }));
  });

  test("the hub routes a frame to its organization only, apart from the events", () => {
    const hub = new EventHub();
    const mine: unknown[] = [];
    const events: unknown[] = [];
    const stop = hub.subscribeRuntimeChanged("org-1", (frame) => mine.push(frame));
    hub.subscribe("org-1", (event) => events.push(event));
    hub.subscribeRuntimeChanged("org-2", () => { throw new Error("wrong organization"); });
    hub.publishRuntimeChanged("org-1", { runtimeId: "rt-1", reason: "changed" });
    expect(mine).toEqual([{ runtimeId: "rt-1", reason: "changed" }]);
    expect(events).toEqual([]);
    expect(hub.runtimeSubscribedOrganizations().sort()).toEqual(["org-1", "org-2"]);
    expect(hub.subscriberCount()).toBe(1);
    stop();
    hub.publishRuntimeChanged("org-1", { runtimeId: "rt-1", reason: "changed" });
    expect(mine).toHaveLength(1);
    expect(hub.runtimeSubscribedOrganizations()).toEqual(["org-2"]);
  });
});
