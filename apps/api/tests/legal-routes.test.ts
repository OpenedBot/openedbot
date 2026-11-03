import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { LEGAL_SLUGS } from "@openedbot/contracts-api";
import { legalRoutes } from "../src/routes/legal/legal-routes";
import type { LegalConfig } from "../src/infrastructure/config";

function fixture(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ohb-legal-"));
  const path = join(directory, "document.md");
  writeFileSync(path, content);
  return path;
}

function config(files: Partial<LegalConfig["files"]>, maxBytes = 256 * 1024): LegalConfig {
  return {
    maxBytes,
    files: {
      mentions: files.mentions ?? null,
      privacy: files.privacy ?? null,
      terms: files.terms ?? null,
    },
  };
}

function appFor(configValue: LegalConfig) {
  const app = new Hono();
  app.route("/", legalRoutes(configValue));
  app.onError((error, context) => {
    const httpError = error as { status?: number; code?: string; message?: string };
    return context.json({ error: { code: httpError.code, message: httpError.message } }, (httpError.status ?? 500) as 400);
  });
  return app;
}

describe("public legal routes", () => {
  test("returns the fixed catalog without reading a slug as a path", async () => {
    const routes = appFor(config({ privacy: fixture("# Privacy\n") }));
    const response = await routes.request("http://api.test/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      documents: LEGAL_SLUGS.map((slug) => ({ slug, available: slug === "privacy" })),
    });

    const traversal = await routes.request("http://api.test/%2e%2e%2fsecret");
    expect(traversal.status).toBe(404);
  });

  test("serves bounded Markdown only for an allowlisted slug", async () => {
    const routes = appFor(config({ terms: fixture("# Terms\n\n[link](javascript:alert(1))\n") }));
    const response = await routes.request("http://api.test/terms");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "terms",
      content: "# Terms\n\n[link](javascript:alert(1))\n",
      contentType: "text/markdown",
    });
  });

  test("reports missing and oversized development documents as unavailable", async () => {
    const routes = appFor(config({ mentions: fixture("12345") }, 4));
    const catalog = await routes.request("http://api.test/");
    const missing = await routes.request("http://api.test/privacy");
    const oversized = await routes.request("http://api.test/mentions");
    expect((await catalog.json()) as { documents: Array<{ slug: string; available: boolean }> }).toEqual({
      documents: LEGAL_SLUGS.map((slug) => ({ slug, available: false })),
    });
    expect(missing.status).toBe(503);
    expect(oversized.status).toBe(503);
    expect(await missing.json()).toEqual({
      error: {
        code: "LEGAL_DOCUMENT_UNAVAILABLE",
        message: "Cette page légale n’est pas disponible sur ce déploiement.",
      },
    });
  });
});
