import { randomInt } from "node:crypto";
import { inspectFailure } from "../kit/failure-inspection";
import { readThreadCompaction } from "../../../../modules/conversation/src/application/compact-thread";
import type { BotDto, GroupDto, ThreadCompactResult } from "@openedbot/contracts-api";
import type { Scenario } from "../kit/scenario";
import type { MessageAttachmentInput } from "../../../../modules/conversation/src/domain/attachments";
import { proofPng } from "../kit/p1-image";
import { completed, deleteGroup, invariant, keyedPost, noTools, ownGroup, readyBot, restartIdleGateway } from "../kit/p1-evidence";

type Message = { id: string; role: string; runId: string | null; content: Array<{ type: string; id?: string; name?: string }> };
type Snapshot = { messages: Message[] };

export const attachmentsContext: Scenario = {
  id: "attachments-context",
  title: "Image, document et contexte compacté",
  summary: "Des valeurs inconnues sont lues dans les pixels et un document, les fichiers sont relus après reprise puis les faits restent utilisables après une vraie compaction du salon.",
  async run(context) {
    const { session, lab, rec, config } = context;
    const imageCode = String(randomInt(10000, 100000));
    const documentCode = `DOC_${crypto.randomUUID().replaceAll("-", "")}`;
    const recoveryImageCode = String(10000 + (Number(imageCode) - 10000 + randomInt(1, 90000)) % 90000);
    const recoveryDocumentCode = `DOC_${crypto.randomUUID().replaceAll("-", "")}`;
    const image = proofPng(imageCode, recoveryImageCode);
    const document = `Release acceptance requirements. Initial verification code: ${documentCode}. Recovery verification code: ${recoveryDocumentCode}. The image has an initial code in its upper row and a recovery code in its lower row. Preserve all four exact proofs in summaries until acceptance completes.`;
    const expected = `${documentCode} ${imageCode}`;
    const recoveryExpected = `${recoveryDocumentCode} ${recoveryImageCode}`;
    const allProofs = [documentCode, imageCode, recoveryDocumentCode, recoveryImageCode];
    let bot!: BotDto;
    let group: GroupDto | undefined;
    let sourceMessageId = "";
    let sourceRunId = "";
    let persistedAttachments: Array<{ id: string; name: string }> = [];
    const verifyStoredAttachments = async () => {
      invariant(persistedAttachments.length === 2, "Both attachment identities are required for independent readback.");
      for (const attachment of persistedAttachments) {
        const response = await session.raw("GET", `/api/attachments/${attachment.id}`);
        invariant(response.ok, `Attachment ${attachment.name} could not be read back.`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const wanted = attachment.name === "proof.png" ? image : Buffer.from(document);
        invariant(bytes.equals(wanted), `Stored attachment ${attachment.name} differs from the submitted fixture bytes.`);
      }
    };
    try {
      await rec.step("Salon jetable et pièces jointes réelles", async () => {
        bot = await readyBot(context, "E2E Attachment reader");
        const companion = await readyBot(context, "E2E Attachment companion");
        await noTools(session, bot); await noTools(session, companion);
        group = await ownGroup(session, `E2E Context ${lab.tag}`, [bot, companion]);
        const attachments: MessageAttachmentInput[] = [
          { name: "release.txt", contentType: "text/plain", kind: "document", content: [{ type: "text", text: `<attachment name="release.txt" type="text/plain">\n${document}\n</attachment>` }] },
          { name: "proof.png", contentType: "image/png", kind: "image", content: [{ type: "image", image: `data:image/png;base64,${image.toString("base64")}` }] },
        ];
        const admitted = await keyedPost<{ runId: string }>(session, `/api/threads/${group.threadId}/messages`, crypto.randomUUID(), {
          input: `@${bot.slug} Read the attached document and image. Return only the INITIAL document verification code, one space, then the five digits in the UPPER image row. Do not return or describe the recovery code or lower row yet. These are release requirements. Do not use tools.`, attachments,
        });
        sourceRunId = admitted.body.runId;
        completed(await lab.follow(sourceRunId, Date.now()), expected);
        const snapshot = await session.api<Snapshot>("GET", `/api/threads/${group.threadId}`);
        const source = snapshot.messages.find((message) => message.role === "user" && message.runId === sourceRunId);
        invariant(source, "The attachment source message is missing.");
        sourceMessageId = source.id;
        const chips = source.content.filter((part) => part.type === "attachment");
        invariant(chips.length === 2, "The source message did not persist both attachments.");
        persistedAttachments = chips.map((chip) => {
          invariant(chip.id && (chip.name === "proof.png" || chip.name === "release.txt"), "An attachment has no expected persisted identity.");
          return { id: chip.id, name: chip.name };
        });
        const priorAssistantText = snapshot.messages.filter((message) => message.role === "assistant").map((message) => JSON.stringify(message.content)).join("\n");
        invariant(!priorAssistantText.includes(recoveryDocumentCode) && !priorAssistantText.includes(recoveryImageCode), "A recovery-only fact already leaked into assistant history before the restart.");
        await verifyStoredAttachments();
        return { runId: sourceRunId, attachments: chips.length, pixelsRead: true };
      });
      await rec.step("Pièce malformée refusée avant admission", async () => {
        const malformedName = `e2e-malformed-${lab.tag}.png`;
        const persistedCounts = async () => {
          const rows = await lab.db<Array<{ runs: number; messages: number; attachments: number; bytes: number; ingresses: number }>>`
            select
              (select count(*)::int from runs where organization_id = ${session.organizationId} and thread_id = ${group!.threadId}) as runs,
              (select count(*)::int from messages where organization_id = ${session.organizationId} and thread_id = ${group!.threadId}) as messages,
              (select count(*)::int from attachments a where a.organization_id = ${session.organizationId}
                and (a.message_id in (select id from messages where organization_id = ${session.organizationId} and thread_id = ${group!.threadId}) or a.name = ${malformedName})) as attachments,
              (select coalesce(sum(a.bytes), 0)::int from attachments a where a.organization_id = ${session.organizationId}
                and (a.message_id in (select id from messages where organization_id = ${session.organizationId} and thread_id = ${group!.threadId}) or a.name = ${malformedName})) as bytes,
              (select count(*)::int from message_ingress where organization_id = ${session.organizationId} and thread_id = ${group!.threadId}) as ingresses`;
          invariant(rows[0], "The malformed attachment persistence baseline is missing.");
          return rows[0];
        };
        const before = await persistedCounts();
        const response = await session.raw("POST", `/api/threads/${group!.threadId}/messages`, { input: "Invalid fixture", attachments: [{ name: malformedName, kind: "image", contentType: "image/png", content: [{ type: "image", image: "not-a-data-uri" }] }] });
        invariant(response.status === 400 || response.status === 413, `Malformed image answered ${response.status}.`);
        const after = await persistedCounts();
        invariant(Object.entries(before).every(([key, value]) => after[key as keyof typeof after] === value), "Rejecting a malformed image still changed durable runs, messages, blob records or submission receipts.");
        await verifyStoredAttachments();
        return { rejectedStatus: response.status, persistedRowsUnchanged: true, storedBytesUnchanged: true };
      });
      await rec.step("Reprise après redémarrage, fichiers toujours exploitables", async () => {
        await restartIdleGateway(context, [bot.id]);
        await verifyStoredAttachments();
        const turn = await keyedPost<{ runId: string }>(session, `/api/threads/${group!.threadId}/messages`, crypto.randomUUID(), {
          input: `@${bot.slug} Reopen the original two attachments in the message I am replying to. This time return only the RECOVERY verification code in the document, one space, then the five digits in the LOWER image row. Neither answer has been given in an assistant message. Do not repeat the initial proofs. Preserve all four release proofs in later summaries.`, replyToId: sourceMessageId,
        });
        completed(await lab.follow(turn.body.runId, Date.now()), recoveryExpected);
        return { runId: turn.body.runId, resumedAfterRestart: true, storedAttachmentsReread: 2, previouslyUnansweredProofs: 2 };
      });
      await rec.step("Historique réel puis compaction persistée", async () => {
        const filler = "This is disposable filler, not a release requirement. ".repeat(360);
        completed(await lab.send(group!.threadId, `@${bot.slug} Keep the earlier release requirements. The following filler is irrelevant. Reply exactly ACK.\n${filler}`), "ACK");
        const result = await keyedPost<ThreadCompactResult>(session, `/api/threads/${group!.threadId}/compact`, crypto.randomUUID(), undefined, 200, Math.max(config.runTimeoutMs, 270_000));
        invariant(result.body.compacted && result.body.summarizedCount > 0 && result.body.compactedThroughSequence > 0, "The compaction did not fold any history.");
        const compaction = await readThreadCompaction(lab.db, session.organizationId, group!.threadId);
        invariant(compaction !== null && compaction.sourceMessageCount > 0 && allProofs.every((proof) => compaction.summary.includes(proof)), "The durable summary lost an exact release proof.");
        return { summarizedCount: result.body.summarizedCount, watermark: result.body.compactedThroughSequence };
      });
      await rec.step("Les faits restent utilisables après compaction", async () => {
        completed(await lab.send(group!.threadId, `@${bot.slug} From the release requirements in this conversation, return only four space-separated values in this order: initial document code, upper image digits, recovery document code, lower image digits. Do not open or reattach any file.`), allProofs.join(" "));
      });
    } catch (failure) {
      try {
        await inspectFailure({ scenario: "attachments-context", runtime: session.runtime.id, labTag: lab.tag,
          outDir: config.outDir, milliseconds: config.failureInspectionMs, caseKey: rec });
      } finally { throw failure; }
    } finally { if (group) await deleteGroup(session, group.id); }
  },
};
