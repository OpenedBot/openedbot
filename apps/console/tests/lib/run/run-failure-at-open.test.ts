import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useRunFailureAtOpen } from "../../../src/lib/run/run-failure-at-open";

afterEach(() => cleanup());

type Props = { threadId: string | null; ready: boolean; run: { id: string; status: string } | undefined };

describe("useRunFailureAtOpen", () => {
  test("a run already failed at the first fresh read is the one not to surface", () => {
    const hook = renderHook<string | null, Props>((props) => useRunFailureAtOpen(props.threadId, props.ready, props.run), {
      initialProps: { threadId: "t1", ready: false, run: undefined },
    });
    expect(hook.result.current).toBeNull();
    hook.rerender({ threadId: "t1", ready: true, run: { id: "r1", status: "failed" } });
    expect(hook.result.current).toBe("r1");
    // A later run that fails while the thread is open is not the baseline.
    hook.rerender({ threadId: "t1", ready: true, run: { id: "r2", status: "failed" } });
    expect(hook.result.current).toBe("r1");
  });

  test("a run still going at the first read fails later and is surfaced", () => {
    const hook = renderHook<string | null, Props>((props) => useRunFailureAtOpen(props.threadId, props.ready, props.run), {
      initialProps: { threadId: "t1", ready: true, run: { id: "r1", status: "running" } },
    });
    expect(hook.result.current).toBeNull();
    hook.rerender({ threadId: "t1", ready: true, run: { id: "r1", status: "failed" } });
    expect(hook.result.current).toBeNull();
  });

  test("a restored snapshot never sets the baseline; each thread gets its own", () => {
    const hook = renderHook<string | null, Props>((props) => useRunFailureAtOpen(props.threadId, props.ready, props.run), {
      initialProps: { threadId: "t1", ready: false, run: { id: "old", status: "failed" } },
    });
    expect(hook.result.current).toBeNull();
    hook.rerender({ threadId: "t1", ready: true, run: { id: "r1", status: "completed" } });
    expect(hook.result.current).toBeNull();
    hook.rerender({ threadId: "t2", ready: true, run: { id: "r9", status: "failed" } });
    expect(hook.result.current).toBe("r9");
  });
});
