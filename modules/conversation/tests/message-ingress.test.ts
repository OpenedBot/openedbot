import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { canonicalMessageHash, readIdempotencyKey, reserveMessageIngress } from "../src/application/message-ingress";
import { HttpError } from "@openedbot/contracts-errors/http-error";

const attachment = {
  name: "a.txt",
  contentType: "text/plain",
  kind: "document" as const,
  content: [{ type: "text" as const, text: "hello" }],
};

describe("message ingress idempotency", () => {
  test("la clé est un UUID canonique", () => {
    expect(readIdempotencyKey("550E8400-E29B-41D4-A716-446655440000"))
      .toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(readIdempotencyKey(undefined)).toBeNull();
    expect(() => readIdempotencyKey("retry-1")).toThrow(HttpError);
  });

  test("le hash couvre le texte normalisé, l'ordre et les octets des pièces", () => {
    expect(canonicalMessageHash("  bonjour  ", [attachment])).toBe(canonicalMessageHash("bonjour", [attachment]));
    expect(canonicalMessageHash("bonjour", [attachment]))
      .not.toBe(canonicalMessageHash("bonjour", [{ ...attachment, content: [{ type: "text", text: "bye" }] }]));
    expect(canonicalMessageHash("bonjour", [attachment, { ...attachment, name: "b.txt" }]))
      .not.toBe(canonicalMessageHash("bonjour", [{ ...attachment, name: "b.txt" }, attachment]));
    expect(canonicalMessageHash("bonjour", [attachment], { replyToId: "message-1" }))
      .not.toBe(canonicalMessageHash("bonjour", [attachment], { replyToId: "message-2" }));
    // « Planifier d'abord » change l'opération ; son absence garde le hash d'avant.
    expect(canonicalMessageHash("bonjour", [attachment], { planOnly: true }))
      .not.toBe(canonicalMessageHash("bonjour", [attachment]));
    expect(canonicalMessageHash("bonjour", [attachment], { planOnly: false }))
      .toBe(canonicalMessageHash("bonjour", [attachment]));
  });

  test("un thread absent ou hors tenant est un 404 avant toute réservation", async () => {
    const statements: string[] = [];
    const tx = ((strings: TemplateStringsArray) => {
      const sql = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push(sql);
      if (sql.startsWith("select set_config")) return Promise.resolve([]);
      if (sql.startsWith("select id from threads")) return Promise.resolve([]);
      throw new Error(`Unexpected SQL after missing thread: ${sql}`);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);

    const promise = reserveMessageIngress({
      db: tx,
      auth: {
        organizationId: "10000000-0000-4000-8000-000000000001",
        userId: "10000000-0000-4000-8000-000000000002",
      },
      threadId: "10000000-0000-4000-8000-000000000003",
      key: "550e8400-e29b-41d4-a716-446655440000",
      requestHash: "a".repeat(64),
      attachments: [],
      objectKey: (id) => `org/10000000-0000-4000-8000-000000000001/${id}`,
    });

    await expect(promise).rejects.toMatchObject({ status: 404, code: "THREAD_NOT_FOUND" });
    expect(statements.some((sql) => sql.startsWith("insert into message_ingress"))).toBe(false);
  });
});
