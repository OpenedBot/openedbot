import { createHash } from "node:crypto";
import type { PersonaDraftDto } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { insertCreationDraftThread } from "@openedbot/conversation/sql/threads";
import { insertPersonaDraftRun } from "@openedbot/execution/sql/runs";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { CreationDraftRequest } from "../domain/bot-input";
import { PERSONA_MAX_CHARS, formatCreatePersonaDraftInput } from "../domain/persona";
import {
  PERSONA_DRAFT_HISTORY,
  formatPersonaDraftTranscript,
  personaDraftCreateSessionKey,
  personaDraftSessionKey,
} from "../domain/persona-draft";
import {
  botExists,
  ensurePersonaDraftThread,
  hasActivePersonaDraftRun,
  lockBotForPersonaDraft,
  readCreationDraftRun,
  readLatestPersonaDraftRun,
  readPersonaDraftRun,
  readThreadHistory,
  setBotInstructions,
} from "../sql/bot-activity";
import type { BotDeps } from "./bot-host";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Met un brouillon de persona en file pour un bot existant, à partir de sa conversation. */
export async function queuePersonaDraft(db: Db, organizationId: string, botId: string): Promise<PersonaDraftDto> {
  const queued = await withTenant(db, organizationId, async (tx) => {
    const bot = await lockBotForPersonaDraft(tx, organizationId, botId);
    if (!bot) return { kind: "missing" } as const;
    if (await hasActivePersonaDraftRun(tx, organizationId, bot.id)) return { kind: "busy" } as const;
    const history = await readThreadHistory(tx, organizationId, bot.threadId, PERSONA_DRAFT_HISTORY);
    const transcript = formatPersonaDraftTranscript(
      [...history].reverse().map((row) => ({
        role: row.role,
        text: Array.isArray(row.content)
          ? row.content
              .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : ""))
              .filter(Boolean)
              .join("\n")
              .trim()
          : typeof row.content === "string" ? row.content : "",
      })).filter((row) => row.text.length > 0),
    );
    const sessionKey = personaDraftSessionKey(organizationId, bot.id);
    const draftThreadId = await ensurePersonaDraftThread(tx, organizationId, bot.id, bot.name, sessionKey);
    const runId = await insertPersonaDraftRun(tx, {
      organizationId,
      threadId: draftThreadId,
      botId: bot.id,
      prompt: transcript,
      sessionKey,
    });
    return { kind: "queued", runId } as const;
  });
  if (queued.kind === "missing") throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  if (queued.kind === "busy") {
    throw new HttpError(409, "BOT_BUSY", "Un brouillon de persona est déjà en cours pour ce bot. Attendez qu'il soit prêt.");
  }
  return {
    status: "queued",
    runId: queued.runId,
    draft: null,
    hash: null,
  } satisfies PersonaDraftDto;
}

/** Le dernier brouillon du bot, avec le hash que l'opérateur devra confirmer. */
export async function readLatestPersonaDraft(db: Db, organizationId: string, botId: string): Promise<PersonaDraftDto> {
  const found = await withTenant(db, organizationId, async (tx) => {
    if (!(await botExists(tx, organizationId, botId))) return null;
    return (await readLatestPersonaDraftRun(tx, organizationId, botId)) ?? { id: null, status: "missing", output: null };
  });
  if (!found) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  if (!found.id) {
    return { status: "missing", runId: null, draft: null, hash: null } satisfies PersonaDraftDto;
  }
  const draft = found.status === "completed" ? (found.output ?? "").trim() : null;
  return {
    status: found.status as PersonaDraftDto["status"],
    runId: found.id,
    draft,
    hash: draft ? sha256Hex(draft) : null,
  } satisfies PersonaDraftDto;
}

/** Applique le brouillon à la persona du bot, si le hash lu par l'opérateur est celui des octets proposés. */
export async function confirmPersonaDraft(
  db: Db,
  organizationId: string,
  botId: string,
  runId: string,
  expectedHash: string,
): Promise<PersonaDraftDto> {
  const rows = await withTenant(db, organizationId, async (tx) => {
    const run = await readPersonaDraftRun(tx, organizationId, botId, runId);
    if (!run) return { kind: "missing" } as const;
    if (run.status !== "completed") {
      throw new HttpError(409, "PERSONA_DRAFT_NOT_READY", "Le brouillon n’est pas encore prêt.");
    }
    const draft = (run.output ?? "").trim();
    if (!draft) throw new HttpError(409, "PERSONA_DRAFT_EMPTY", "Le brouillon est vide.");
    if (draft.length > PERSONA_MAX_CHARS) {
      throw new HttpError(400, "BOT_INSTRUCTIONS_TOO_LONG", `La persona dépasse ${PERSONA_MAX_CHARS} caractères.`);
    }
    if (sha256Hex(draft) !== expectedHash) {
      throw new HttpError(409, "PERSONA_DRAFT_HASH_MISMATCH", "Le brouillon affiché ne correspond plus aux octets proposés.");
    }
    if (!(await setBotInstructions(tx, organizationId, botId, draft))) return { kind: "missing" } as const;
    return { kind: "applied", draft } as const;
  });
  if (rows.kind === "missing") throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  return { status: "completed", runId, draft: rows.draft, hash: expectedHash } satisfies PersonaDraftDto;
}

/**
 * Un brouillon de persona avant que le bot existe. Le runtime est vérifié
 * AVANT de lire la demande : sans runtime, un corps invalide n'est jamais
 * regardé et l'opérateur apprend d'abord qu'il doit enregistrer Hermes.
 */
export async function requestCreationPersonaDraft(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  readRequest: () => Promise<CreationDraftRequest>,
): Promise<{ runId: string }> {
  const runtime = await deps.readRuntime(db, organizationId);
  if (!runtime) throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de proposer une persona.");
  const { name, role, mission } = await readRequest();
  const prompt = formatCreatePersonaDraftInput({ name, role, mission });
  const runId = await withTenant(db, organizationId, async (tx) => {
    const threadId = crypto.randomUUID();
    const sessionId = personaDraftCreateSessionKey(organizationId, threadId);
    await insertCreationDraftThread(tx, organizationId, threadId, name, sessionId);
    return insertPersonaDraftRun(tx, {
      organizationId,
      threadId,
      botId: null,
      prompt,
      sessionKey: sessionId,
    });
  });
  return { runId };
}

/** L'état d'un brouillon demandé avant la création du bot. */
export async function readCreationPersonaDraft(
  db: Db,
  organizationId: string,
  runId: string,
): Promise<{ status: string; draft: string | null }> {
  const found = await withTenant(db, organizationId, (tx) => readCreationDraftRun(tx, organizationId, runId));
  if (!found) throw new HttpError(404, "PERSONA_DRAFT_NOT_FOUND", "Brouillon introuvable.");
  const draft = found.status === "completed" ? (found.output ?? "").trim() : null;
  return { status: found.status, draft };
}
