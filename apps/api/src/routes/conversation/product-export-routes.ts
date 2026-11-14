import { Hono } from "hono";
import { isUuid } from "@openedbot/contracts-primitives";
import { withTenant, type Db } from "@openedbot/platform-db";
import { readExportMessagePage } from "@openedbot/conversation/application/conversation-export";
import { selectBotConfigurationExport } from "@openedbot/roster/application/product-export";
import { selectBotRoutineExports } from "@openedbot/execution/application/product-export";
import {
  exportMessageMarkdown,
  MAX_CONVERSATION_EXPORT_BYTES,
} from "@openedbot/conversation/domain/conversation-export";
import type { AppVariables } from "../identity/auth";
import { requireRole } from "../identity/auth";
import { HttpError } from "../../interfaces/http/http-error";
import { requireExportThread } from "./conversation-files-routes";

export function productExportRoutes(db: Db) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/threads/:threadId", async (c) => {
    const { organizationId } = c.get("auth");
    const threadId = c.req.param("threadId");
    const markdown = await (db.begin(async (tx) => {
      // A single snapshot fences concurrent sends/edits. Pages bound individual SQL reads.
      await tx`set transaction isolation level repeatable read`;
      await tx`select set_config('app.organization_id',${organizationId},true)`;
      await tx`set local statement_timeout='15s'`;
      const thread = await requireExportThread(tx, organizationId, threadId);
      const chunks = [
        `# ${thread.title.replace(/[\r\n]/g, " ")}\n\nExported: ${new Date().toISOString()}\n\nAttachment references only; file binaries are not included. / Références uniquement, fichiers binaires non inclus.\n\n`,
      ];
      let sequence = "-1";
      let bytes = 0;
      const started = Date.now();
      for (;;) {
        if (c.req.raw.signal.aborted)
          throw new HttpError(499, "EXPORT_CANCELLED", "Export annulé.");
        if (Date.now() - started > 30_000)
          throw new HttpError(
            413,
            "EXPORT_TOO_LARGE",
            "Conversation trop volumineuse pour cet export.",
          );
        const messages = await readExportMessagePage(
          tx,
          organizationId,
          threadId,
          sequence,
        );
        for (const m of messages) {
          const chunk = exportMessageMarkdown(m);
          bytes += new TextEncoder().encode(chunk).length;
          if (bytes > MAX_CONVERSATION_EXPORT_BYTES)
            throw new HttpError(
              413,
              "EXPORT_TOO_LARGE",
              "Export limité à 32 Mio. Aucun fichier partiel n’a été produit.",
            );
          chunks.push(chunk);
          sequence = m.sequence;
        }
        if (messages.length < 200) break;
      }
      return chunks.join("");
    }) as Promise<string>);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="conversation-${threadId}.md"`,
    );
    c.header("Cache-Control", "no-store");
    return c.body(markdown);
  });
  routes.get("/bots/:botId", async (c) => {
    const auth = c.get("auth");
    requireRole(
      auth,
      ["owner", "admin"],
      "Seuls les administrateurs exportent la configuration.",
    );
    const botId = c.req.param("botId");
    if (!isUuid(botId))
      throw new HttpError(400, "BOT_ID_INVALID", "Bot invalide.");
    const document = await withTenant(db, auth.organizationId, async (tx) => {
      const bot = await selectBotConfigurationExport(
        tx,
        auth.organizationId,
        botId,
      );
      if (!bot) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
      const routines = await selectBotRoutineExports(
        tx,
        auth.organizationId,
        botId,
      );
      return {
        format: "openedbot.bot",
        version: 1,
        exportedAt: new Date().toISOString(),
        bot,
        routines,
      };
    });
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Cache-Control", "no-store");
    c.header("Content-Disposition", `attachment; filename="bot-${botId}.json"`);
    return c.body(JSON.stringify(document, null, 2));
  });
  return routes;
}
