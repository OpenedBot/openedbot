import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  accessLogMiddleware,
  channelOf,
  createTestLogger,
  currentRequestId,
  LOG_REDACT_CENSOR,
  logEvent,
  REQUEST_ID_HEADER,
  runWithLogger,
  runWithRequest,
} from "../src/logger";

describe("channelOf", () => {
  test("déduit le canal du nom d'événement", () => {
    expect(channelOf("pro.user_created")).toBe("api");
    expect(channelOf("pro.access_email_skipped_failed")).toBe("email");
    expect(channelOf("support.confirmation_enqueue_failed")).toBe("email");
    expect(channelOf("auth.google.refused")).toBe("auth");
    expect(channelOf("runtime_link.worm_write_failed")).toBe("runtime_link");
    expect(channelOf("api.unhandled_error")).toBe("api");
    expect(channelOf("alerting.started")).toBe("api");
  });
});

describe("createTestLogger", () => {
  test("capture les lignes en mémoire, sans toucher stdout", () => {
    const { logger, records } = createTestLogger();
    logger.info({ event: "api.started", url: "http://127.0.0.1" }, "api started");
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe("api.started");
    expect(records[0]?.channel).toBe("api");
    expect(records[0]?.msg).toBe("api started");
    expect(records[0]).not.toHaveProperty("requestId");
  });

  test("censure un secret passé dans les champs, pas seulement la liste exportée", () => {
    const { logger, records } = createTestLogger();
    logger.info({ event: "api.x", account: { password: "s3cret" } }, "x");
    const account = records[0]?.account as { password?: string } | undefined;
    expect(account?.password).toBe(LOG_REDACT_CENSOR);
    expect(JSON.stringify(records[0])).not.toContain("s3cret");
  });

  test("un suffixe d'anomalie passe en warn via logEvent", () => {
    const { logger, records } = createTestLogger();
    runWithLogger(logger, () => {
      logEvent("pro.access_email_skipped_failed", { domain: "exemple.test" });
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe(40);
    expect(records[0]?.channel).toBe("email");
    expect(records[0]?.domain).toBe("exemple.test");
  });
});

describe("contexte de requête", () => {
  test("le mixin colle le requestId de l'ALS, un appel hors requête n'en a pas", () => {
    const { logger, records } = createTestLogger();
    runWithLogger(logger, () => {
      logEvent("api.started");
      runWithRequest("req-1", () => {
        expect(currentRequestId()).toBe("req-1");
        logEvent("runtime_link.user_created", { domain: "exemple.test" });
      });
      logEvent("api.stopping", { signal: "SIGTERM" });
    });
    expect(records).toHaveLength(3);
    expect(records[0]).not.toHaveProperty("requestId");
    expect(records[1]?.requestId).toBe("req-1");
    expect(records[1]?.channel).toBe("runtime_link");
    expect(records[2]).not.toHaveProperty("requestId");
  });

  test("un logEvent pendant la requête porte le même requestId que l'access-log et l'en-tête", async () => {
    const { logger, records } = createTestLogger();
    const app = new Hono();
    app.use("*", accessLogMiddleware({ newRequestId: () => "req-fixed" }));
    app.get("/", (context) => {
      logEvent("runtime_link.user_created", { domain: "exemple.test" });
      return context.json({ ok: true });
    });

    const response = await runWithLogger(logger, () => app.request("/"));

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-fixed");
    const granted = records.find((line) => line.event === "runtime_link.user_created");
    const http = records.find((line) => line.msg === "http request");
    expect(granted?.requestId).toBe("req-fixed");
    expect(granted?.channel).toBe("runtime_link");
    expect(http?.requestId).toBe("req-fixed");
    expect(http?.channel).toBe("http");
  });

  test("n'écrase pas un requestId déjà passé par l'appelant", () => {
    const { logger, records } = createTestLogger();
    runWithRequest("from-als", () => {
      logger.error({ event: "api.unhandled_error", requestId: "from-caller" }, "unhandled error");
    });
    expect(records[0]?.requestId).toBe("from-caller");
  });
});
