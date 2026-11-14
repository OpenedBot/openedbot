import { Hono } from "hono";
import { isUuid } from "@openedbot/contracts-primitives";
import {
  withTenant,
  type Db,
  type TransactionDb,
} from "@openedbot/platform-db";
import { readExportThread } from "@openedbot/conversation/application/conversation-export";
import { botAvailableForExport } from "@openedbot/roster/application/product-export";
import {
  listConversationFiles,
  conversationFileCursorExists,
} from "@openedbot/conversation/application/conversation-files";
import type { AppVariables } from "../identity/auth";
import { HttpError } from "../../interfaces/http/http-error";

export async function requireExportThread(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
) {
  if (!isUuid(threadId))
    throw new HttpError(400, "THREAD_ID_INVALID", "Conversation invalide.");
  const rows = await readExportThread(tx, organizationId, threadId);
  if (
    rows[0]?.botId &&
    !(await botAvailableForExport(tx, organizationId, rows[0].botId))
  )
    throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
  if (!rows[0])
    throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
  return rows[0];
}
export function conversationFilesRoutes(db: Db) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/:threadId/files", async (c) => {
    const { organizationId } = c.get("auth");
    const threadId = c.req.param("threadId");
    const search = (c.req.query("q") ?? "").trim();
    const cursor = c.req.query("cursor") ?? null;
    if (search.length > 200 || (cursor !== null && !isUuid(cursor)))
      throw new HttpError(
        400,
        "FILES_QUERY_INVALID",
        "Recherche ou curseur invalide.",
      );
    const page = await withTenant(db, organizationId, async (tx) => {
      await requireExportThread(tx, organizationId, threadId);
      if (cursor) {
        const anchor = await conversationFileCursorExists(
          tx,
          organizationId,
          threadId,
          cursor,
        );
        if (!anchor)
          throw new HttpError(
            400,
            "FILES_CURSOR_INVALID",
            "Curseur invalide pour cette conversation.",
          );
      }
      const rows = await listConversationFiles(
        tx,
        organizationId,
        threadId,
        search,
        cursor,
      );
      return {
        files: rows.slice(0, 40),
        nextCursor: rows.length > 40 ? rows[39]!.id : null,
      };
    });
    c.header("Cache-Control", "no-store");
    return c.json(page);
  });
  return routes;
}
