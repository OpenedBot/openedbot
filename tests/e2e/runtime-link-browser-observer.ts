/** Preparation only: prints an expression for the registered Ghostchrome MCP
 * eval tool. This file never starts/connects to a browser or contacts a service. */
export type ObserverManifest = { nonce: string; threadId: string; apiOrigin: string; pageOrigin: string; eventOrigin?: string; botId?: string; observationSeconds: number };
export function installContinuityObserver(config: ObserverManifest) {
  const host = globalThis as typeof globalThis & { __openedbotContinuityEvidence?: { snapshot: (stop?: boolean) => unknown } };
  if (location.origin !== config.pageOrigin || host.__openedbotContinuityEvidence) throw new Error("Wrong page origin or observer already installed");
  const original = globalThis.fetch;
  const evidence = { schemaVersion: 1, source: "ghostchrome-mcp-page-fetch", phase: "observing", nonce: config.nonce, threadId: config.threadId,
    apiOrigin: config.apiOrigin, eventOrigin: config.eventOrigin ?? config.pageOrigin, pageOrigin: location.origin, pagePath: location.pathname, installedAt: new Date().toISOString(), exportedAt: "", dropped: 0,
    requests: [] as Array<{ id: number; at: string; cursor: number; status?: number; bytes: number; frames: number; matchingFrames: number; endedAt?: string }>,
    events: [] as Array<{ requestId: number; at: string; runId: string; cursor: number; sequence: number; type: string }>,
    rendered: [] as Array<{ target: string; count: number; nonempty: boolean }>, gaps: [] as Array<{ requestId: number; at: string; from: number; to: number }>, errors: [] as string[] };
  let stopped = false;
  const fail = (error: string) => { if (evidence.errors.length < 10) evidence.errors.push(error); };
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (stopped || url.origin !== (config.eventOrigin ?? config.pageOrigin) || url.pathname !== "/api/events") return original(input, init);
    if (evidence.requests.length >= 1000) { evidence.dropped++; return original(input, init); }
    const request = { id: evidence.requests.length + 1, at: new Date().toISOString(), cursor: Number(url.searchParams.get("cursor") ?? 0), status: 0, bytes: 0, frames: 0, matchingFrames: 0, endedAt: undefined as string | undefined };
    evidence.requests.push(request);
    // Never inspect auth headers, cookies or event payload text. Observe the
    // bytes consumed by the actual application, with no parallel SSE subscriber.
    const response = await original(input, init); request.status = response.status;
    if (!response.ok || !response.body) return response;
    const decoder = new TextDecoder(); let buffer = "";
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        request.bytes += chunk.byteLength;
        if (stopped) return;
        buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
        if (buffer.length > 4_000_000) { fail("Observer frame exceeded bound"); buffer = ""; return; }
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          request.frames++;
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try {
            const event = JSON.parse(data);
            if (/^event:\s*stream.gap$/m.test(frame)) {
              if (!Number.isSafeInteger(event.from) || !Number.isSafeInteger(event.to) || event.from < 0 || event.to <= event.from) fail("Invalid application stream gap");
              else if (evidence.gaps.length >= 1000) evidence.dropped++;
              else evidence.gaps.push({ requestId: request.id, at: new Date().toISOString(), from: event.from, to: event.to });
              continue;
            }
            if (event.threadId !== config.threadId) continue;
            request.matchingFrames++;
            if (evidence.events.length >= 20_000) { evidence.dropped++; continue; }
            if (typeof event.runId !== "string" || !Number.isSafeInteger(event.cursor) || !Number.isSafeInteger(event.sequence) || typeof event.type !== "string") { fail("Application SSE metadata invalid"); continue; }
            evidence.events.push({ requestId: request.id, at: new Date().toISOString(), runId: event.runId, cursor: event.cursor, sequence: event.sequence, type: event.type });
          } catch { fail("Application SSE metadata cannot be parsed"); }
        }
      },
      flush() { request.endedAt = new Date().toISOString(); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  globalThis.fetch = wrapped as typeof fetch;
  const timer = setTimeout(() => { fail("Observer expired before final export"); host.__openedbotContinuityEvidence?.snapshot(true); }, Math.min(90_000, Math.max(60, config.observationSeconds + 3600)) * 1000);
  host.__openedbotContinuityEvidence = { snapshot(stop = false) {
    if (stop) { stopped = true; clearTimeout(timer); if (globalThis.fetch === wrapped) globalThis.fetch = original; evidence.phase = "complete"; }
    const nodes = new Map<string, { target: string; count: number; nonempty: boolean }>();
    for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-thread-messages] [data-thread-find-target]"))) {
      const target = node.dataset.threadFindTarget!;
      if (!target.startsWith("message:")) continue;
      const current = nodes.get(target) ?? { target, count: 0, nonempty: false };
      current.count++; current.nonempty ||= Boolean(node.textContent?.trim()); nodes.set(target, current);
    }
    evidence.rendered = [...nodes.values()]; evidence.pagePath = location.pathname; evidence.exportedAt = new Date().toISOString();
    return JSON.parse(JSON.stringify(evidence));
  } };
  return host.__openedbotContinuityEvidence.snapshot();
}
if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Pass the explicit browser-manifest.json path; this command only prints MCP eval code.");
  const manifest = await Bun.file(path).json() as ObserverManifest;
  if (!manifest.nonce || !manifest.threadId || !manifest.apiOrigin || !manifest.pageOrigin || !Number.isFinite(manifest.observationSeconds)) throw new Error("Incomplete browser manifest");
  console.info(`(${installContinuityObserver.toString()})(${JSON.stringify(manifest)})`);
}
