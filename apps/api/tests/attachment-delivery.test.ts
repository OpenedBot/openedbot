import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import { attachmentDeliveryHeaders, attachmentRoutes, isActiveAttachmentType } from "../src/routes/conversation/attachment-routes";
import { BlobDriverUnavailableError, BlobMetrics, type BlobStore } from "../src/infrastructure/blob-store";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";

const activeTypes = [
  "text/html", " TEXT/HTML ; charset=utf-8", "application/xhtml+xml",
  "IMAGE/SVG+XML; charset=utf-8", "text/xml", "application/xml", "application/custom+xml",
];

function fixture(contentType: string, options: { missing?: boolean; unavailable?: boolean } = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const reads: unknown[][] = [];
  const redirects: unknown[][] = [];
  const row = { objectKey: "org/org-1/file-1", contentType, name: "test.svg", driver: "r2" };
  const db = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    queries.push({ sql, values });
    return Promise.resolve(sql.includes("from attachments") && !options.missing ? [row] : []);
  }, { begin: async (callback: (tx: unknown) => unknown) => callback(db) }) as unknown as SQL;
  const blobs: BlobStore = {
    driver: "file", metrics: new BlobMetrics(),
    put: async () => {}, delete: async () => {},
    get: async (...args) => {
      reads.push(args);
      if (options.unavailable) throw new BlobDriverUnavailableError("r2");
      return new Blob(["fixture"], { type: "application/octet-stream" });
    },
    deliveryUrl: (...args) => { redirects.push(args); return "https://cdn.example.test/file"; },
  };
  const auth: AuthContext = {
    sessionId: "session-1", organizationId: "org-1", userId: "user-1",
    role: "member", kind: "web", credentialHash: "test",
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.onError((error) => {
    if (error instanceof HttpError) return Response.json({ code: error.code }, { status: error.status });
    throw error;
  });
  app.route("/", attachmentRoutes(db, blobs));
  return { app, reads, redirects, queries };
}

describe("active attachment delivery", () => {
  for (const contentType of activeTypes) {
    test(`keeps ${contentType} behind the API policy, never asking for a CDN URL`, async () => {
      expect(isActiveAttachmentType(contentType)).toBe(true);
      const { app, reads, redirects, queries } = fixture(contentType);
      const response = await app.request("/attachment-1");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("fixture");
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toBe(contentType.trim());
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("sandbox;");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(reads).toEqual([["org/org-1/file-1", "r2"]]);
      expect(redirects).toEqual([]);
      expect(queries[0]?.sql).toContain("set_config('app.organization_id'");
      expect(queries[0]?.values).toEqual(["org-1"]);
      expect(queries[1]?.sql).toContain("organization_id =");
      expect(queries[1]?.sql).toContain("deleted_at is null");
      expect(queries[1]?.values).toEqual(["org-1", "attachment-1"]);
    });
  }

  for (const contentType of ["image/png", "IMAGE/JPEG; quality=90", "image/webp", "text/plain", "application/pdf"]) {
    test(`preserves CDN delivery for ${contentType}`, async () => {
      expect(isActiveAttachmentType(contentType)).toBe(false);
      expect(attachmentDeliveryHeaders(contentType, "image.png")["Content-Security-Policy"]).toBeUndefined();
      const { app, reads, redirects } = fixture(contentType);
      const response = await app.request("/attachment-1");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://cdn.example.test/file");
      expect(reads).toEqual([]);
      expect(redirects).toEqual([["org/org-1/file-1", "r2"]]);
    });
  }

  test("a tenant lookup miss never reads or redirects the object", async () => {
    const { app, reads, redirects } = fixture("image/svg+xml", { missing: true });
    const response = await app.request("/attachment-1");
    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
    expect(redirects).toEqual([]);
  });

  test("unavailable active storage fails closed without a CDN fallback", async () => {
    const { app, redirects } = fixture("image/svg+xml", { unavailable: true });
    const response = await app.request("/attachment-1");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "ATTACHMENT_STORAGE_UNAVAILABLE" });
    expect(redirects).toEqual([]);
  });
});
