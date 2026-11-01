import { statSync } from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  LEGAL_SLUGS,
  type LegalCatalogDto,
  type LegalDocumentDto,
  type LegalSlug,
} from "@openedbot/contracts-api";
import type { LegalConfig } from "../../infrastructure/config";
import { HttpError } from "./http-error";

/**
 * Public legal content is deliberately separate from tenant routes. A slug is
 * looked up in this fixed map; it is never interpolated into a directory or
 * accepted as a filesystem path.
 */
export function legalRoutes(config: LegalConfig): Hono {
  const routes = new Hono();

  const catalog = (context: Context) => {
    const result: LegalCatalogDto = {
      documents: LEGAL_SLUGS.map((slug) => ({
        slug,
        available: isAvailable(config.files[slug], config.maxBytes),
      })),
    };
    context.header("Cache-Control", "public, max-age=60");
    return context.json(result);
  };
  routes.get("/", catalog);
  // Keep an explicit noun available for API consumers that do not treat the
  // collection URL as its catalogue endpoint.
  routes.get("/catalog", catalog);

  routes.get("/:slug", async (context) => {
    const slug = context.req.param("slug");
    if (!isLegalSlug(slug)) {
      throw new HttpError(404, "LEGAL_DOCUMENT_NOT_FOUND", "Cette page légale n’existe pas.");
    }

    const filePath = config.files[slug];
    if (!filePath) throw unavailable();

    const content = await readMarkdown(filePath, config.maxBytes);
    const body: LegalDocumentDto = { slug, content, contentType: "text/markdown" };
    context.header("Cache-Control", "public, max-age=300");
    return context.json(body);
  });

  return routes;
}

function isLegalSlug(value: string): value is LegalSlug {
  return (LEGAL_SLUGS as readonly string[]).includes(value);
}

function isAvailable(filePath: string | null, maxBytes: number): boolean {
  if (!filePath) return false;
  try {
    const stat = statSync(filePath);
    return stat.isFile() && stat.size > 0 && stat.size <= maxBytes;
  } catch {
    return false;
  }
}

async function readMarkdown(filePath: string, maxBytes: number): Promise<string> {
  let file: ReturnType<typeof Bun.file>;
  try {
    file = Bun.file(filePath);
    if (!(await file.exists()) || file.size < 1 || file.size > maxBytes) throw unavailable();
    // Read one extra byte so a file changed after stat() cannot bypass the limit.
    const bytes = new Uint8Array(await file.slice(0, maxBytes + 1).arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw unavailable();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unavailable();
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}

function unavailable(): HttpError {
  return new HttpError(
    503,
    "LEGAL_DOCUMENT_UNAVAILABLE",
    "Cette page légale n’est pas disponible sur ce déploiement.",
  );
}
