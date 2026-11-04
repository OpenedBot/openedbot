import { Hono } from "hono";
import type { AppVariables } from "../identity/auth";
import { BlobDriverUnavailableError, type BlobDriver, type BlobStore } from "../../infrastructure/blob-store";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";

export function attachmentRoutes(db: Db, blobs: BlobStore): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/:attachmentId", async (context) => {
    const auth = context.get("auth");
    const attachment = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await tx<Array<{
        objectKey: string; contentType: string; name: string; driver: BlobDriver;
      }>>`
        select object_key as "objectKey", content_type as "contentType", name, driver from attachments
         where organization_id = ${auth.organizationId} and id = ${context.req.param("attachmentId")}
           and deleted_at is null
      `;
      return rows[0] ?? null;
    });
    if (!attachment) throw new HttpError(404, "ATTACHMENT_NOT_FOUND", "Fichier introuvable.");
    // Un HTML servi par redirection CDN n'aurait pas notre CSP. Le canevas
    // n'utilise pas cette URL (il injecte en `srcdoc`), mais une navigation
    // directe sur le GET, elle, doit rester sandboxée.
    // Le driver de la ligne, pas celui du jour : un fichier écrit sur le
    // disque avant le passage à R2 ne reçoit pas une redirection CDN vide.
    let blob: Blob;
    try {
      const url = isHtmlAttachmentType(attachment.contentType)
        ? null
        : blobs.deliveryUrl(attachment.objectKey, attachment.driver);
      if (url) return context.redirect(url, 302);
      blob = await blobs.get(attachment.objectKey, attachment.driver);
    } catch (error) {
      if (error instanceof BlobDriverUnavailableError) {
        throw new HttpError(503, "ATTACHMENT_STORAGE_UNAVAILABLE", "Le stockage de ce fichier n’est pas joignable sur ce déploiement.");
      }
      throw error;
    }
    return new Response(blob, {
      headers: attachmentDeliveryHeaders(attachment.contentType, attachment.name),
    });
  });
  return routes;
}

export function isHtmlAttachmentType(contentType: string): boolean {
  return contentType.toLowerCase().split(";")[0]!.trim() === "text/html";
}

/**
 * `Content-Security-Policy: sandbox` UNIQUEMENT pour `text/html`.
 * Le poser sur une image casserait l'affichage du canevas (`<img src=blob:>`
 * après fetch reste hors sujet ; une navigation directe, elle, verrait
 * l'image refusée par le sandbox).
 */
export function attachmentDeliveryHeaders(contentType: string, name: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "private, max-age=60",
  };
  if (isHtmlAttachmentType(contentType)) {
    headers["Content-Security-Policy"] = "sandbox";
  }
  return headers;
}
