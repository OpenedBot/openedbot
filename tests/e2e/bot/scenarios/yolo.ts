/**
 * Mode YOLO (PR 8/8) on the runtime really linked to the local stack: the
 * host decides alone under a signed lease, and only an inference proves it.
 *
 *   - an owner grants a conversation lease on an EXISTING bot among
 *     Designer, Recherche, Dev, Rédaction and Assistant (never CTO nor CEO,
 *     fixtures without tools); the host reports it `active`;
 *   - a `write_file` under /tmp passes without any gate reaching openedbot,
 *     and the host's audit arrives with the arguments' hash only;
 *   - a write under `.ssh`, under `.env`, and a hardline path (a `yolo.json`,
 *     harmless under /tmp if it ever passed) are refused on the host: no
 *     gate, no audit entry;
 *   - a one-minute lease elapses: the next write raises a gate again (the
 *     normal pipeline), which a person refuses.
 *
 * `edge-setup yolo off` without the link is a host command this runner never
 * runs (no shell on the runtime): `tests/integration/yolo-link.ts` and the Go
 * tests cover it. Whether the model calls the tool is its choice: a turn
 * without the call is a warning, never a pass on the host's behalf. Every
 * lease granted here is revoked before the scenario ends, and no file is
 * left outside /tmp.
 *
 *   make e2e-bot SCENARIOS=yolo   (E2E_ALLOW_REAL_RUNS=1, never in CI)
 */
import type { BotDto, YoloAuditPageDto, YoloLeaseDto } from "@openedbot/contracts-api";
import { Skip, warn } from "../kit/report";
import type { Scenario, ScenarioContext } from "../kit/scenario";

/** The only bots this scenario may use; CTO and CEO are tool-less fixtures. */
const YOLO_BOTS = ["Designer", "Recherche", "Dev", "Rédaction", "Assistant"] as const;
const GATE_WAIT_MS = 120_000;
const HOST_WAIT_MS = 60_000;

type Lab = ScenarioContext["lab"];
type Api = ScenarioContext["session"];

async function poll<T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(1_000);
  }
  return null;
}

async function hostState(lab: Lab, leaseId: string): Promise<string | null> {
  const [row] = await lab.db<Array<{ state: string }>>`select host_state as state from permission_yolo_leases where id = ${leaseId}`;
  return row?.state ?? null;
}

async function auditCount(lab: Lab, leaseId: string): Promise<number> {
  const [row] = await lab.db<Array<{ n: number }>>`select count(*)::int as n from permission_yolo_audit where lease_id = ${leaseId}`;
  return row?.n ?? 0;
}

async function gatesOf(lab: Lab, runId: string) {
  return lab.db<Array<{ id: string; decisionState: string | null; toolKey: string | null }>>`
    select id, decision_state as "decisionState", tool_key as "toolKey" from approval_requests where run_id = ${runId} order by gate_ordinal`;
}

/** Whether the model called `write_file` in this run (a tool event the stream journaled). */
async function calledWrite(lab: Lab, runId: string): Promise<boolean> {
  const rows = await lab.db<Array<{ n: number }>>`
    select count(*)::int as n from run_events where run_id = ${runId} and type in ('tool.started', 'tool.completed') and payload->>'tool' = 'write_file'`;
  return (rows[0]?.n ?? 0) > 0;
}

/** A write the host must decide alone: the run ends without any gate reaching openedbot. */
async function writeWithoutGate(lab: Lab, threadId: string, path: string) {
  const turn = await lab.send(threadId, `Utilise l'outil write_file pour créer le fichier ${path} avec le seul mot bonjour. Appelle l'outil directement.`);
  const gates = await gatesOf(lab, turn.runId);
  if (gates.length > 0) throw new Error(`A gate reached openedbot under the lease (${gates.map((gate) => `${gate.toolKey}:${gate.decisionState}`).join(", ")}).`);
  if (turn.run?.status !== "completed") throw new Error(`The run ended ${String(turn.run?.status)}.`);
  return { runId: turn.runId, called: await calledWrite(lab, turn.runId) };
}

async function grant(session: Api, bot: BotDto, durationMinutes: number): Promise<YoloLeaseDto> {
  const { lease } = await session.api<{ lease: YoloLeaseDto }>("POST", "/api/organization/yolo/leases", {
    scope: "thread", botId: bot.id, threadId: bot.threadId, durationMinutes, acknowledged: true,
  }, 201);
  return lease;
}

export const yolo: Scenario = {
  id: "yolo",
  title: "Mode YOLO",
  summary: "Sous un bail de conversation, l'hôte écrit dans /tmp sans humain et l'audit (hash seulement) remonte ; .ssh, .env et la hardline restent refusés ; un bail échu rend la main au pipeline normal.",
  async run({ lab, session, rec }) {
    let bot!: BotDto;
    let lease: YoloLeaseDto | null = null;
    const granted: string[] = [];
    let pending: string | null = null;
    try {
      await rec.step("Bot autorisé et hôte YOLO", async () => {
        if (!session.hasFeature("yolo_lease") || !session.hasFeature("yolo_thread_scope")) throw new Skip("host without yolo_lease or yolo_thread_scope");
        const { bots } = await session.api<{ bots: BotDto[] }>("GET", "/api/bots");
        const wanted = process.env.E2E_YOLO_BOT;
        if (wanted && !YOLO_BOTS.includes(wanted as (typeof YOLO_BOTS)[number])) throw new Error(`E2E_YOLO_BOT must be one of ${YOLO_BOTS.join(", ")}.`);
        const found = bots.find((candidate) => candidate.name === (wanted ?? candidate.name) && YOLO_BOTS.includes(candidate.name as (typeof YOLO_BOTS)[number]));
        if (!found) throw new Skip(`none of ${YOLO_BOTS.join(", ")} exists in this organization`);
        bot = found;
        return { bot: bot.name, profile: bot.hermesProfile, mode: bot.permissionMode ?? null };
      });

      await rec.step("Bail de conversation livré", async () => {
        lease = await grant(session, bot, 15);
        granted.push(lease.id);
        const state = await poll(async () => ((await hostState(lab, lease!.id)) === "active" ? "active" : null), HOST_WAIT_MS);
        if (!state) throw new Error(`The host never reported the lease active (host_state ${String(await hostState(lab, lease.id))}).`);
        return { leaseId: lease.id, expiresAt: lease.expiresAt };
      });

      await rec.step("/tmp sans humain, audit côté cloud", async () => {
        if (!lease) throw new Skip("no lease");
        const leaseId = lease.id;
        const write = await writeWithoutGate(lab, bot.threadId, `/tmp/ohb-e2e-yolo-${lab.tag}.md`);
        if (!write.called) return warn("The model ended its turn without calling write_file.", write);
        const entries = await poll(async () => {
          const page = await session.api<YoloAuditPageDto>("GET", `/api/organization/yolo/audit?leaseId=${leaseId}`);
          return page.entries.length > 0 ? page.entries : null;
        }, HOST_WAIT_MS);
        if (!entries) throw new Error("The host's auto-approval never reached the cloud audit.");
        const entry = entries[0]!;
        if (entry.gateKind !== "plugin_tool" || entry.toolKey !== "write_file" || !/^[0-9a-f]{64}$/.test(entry.argsHash)) {
          throw new Error(`The audit entry reads ${entry.gateKind}/${String(entry.toolKey)}, not a write_file auto-approval.`);
        }
        if (JSON.stringify(entry).includes(lab.tag)) throw new Error("The cloud audit carries the arguments in clear.");
        return { runId: write.runId, entries: entries.length };
      });

      for (const [label, path] of [
        // Under /tmp too: a protection that failed would still leave nothing outside it.
        [".ssh refusé", `/tmp/ohb-e2e-yolo-${lab.tag}/.ssh/authorized_keys`],
        [".env refusé", `/tmp/ohb-e2e-yolo-${lab.tag}/.env`],
        ["Hardline refusée", `/tmp/ohb-e2e-yolo-${lab.tag}/yolo.json`],
      ] as const) {
        await rec.step(label, async () => {
          if (!lease) throw new Skip("no lease");
          const before = await auditCount(lab, lease.id);
          const write = await writeWithoutGate(lab, bot.threadId, path);
          if (!write.called) return warn("The model ended its turn without calling write_file.", write);
          // The host spool is collected on its own pass: leave it time to show a wrong entry.
          await Bun.sleep(5_000);
          if ((await auditCount(lab, lease.id)) !== before) throw new Error(`The refused write ${path} was audited as auto-approved.`);
          return { runId: write.runId };
        });
      }

      await rec.step("Bail échu : retour au pipeline normal", async () => {
        if (!bot) throw new Skip("no bot");
        // A new lease on the same conversation supersedes the first one.
        const short = await grant(session, bot, 1);
        granted.push(short.id);
        if (!(await poll(async () => ((await hostState(lab, short.id)) === "active" ? "active" : null), HOST_WAIT_MS))) throw new Error("The short lease never became active.");
        await Bun.sleep(Math.max(0, Date.parse(short.expiresAt) - Date.now()) + 5_000);
        const t0 = Date.now();
        const { runId } = await session.api<{ runId: string }>("POST", `/api/threads/${bot.threadId}/messages`, {
          input: `Utilise l'outil write_file pour créer le fichier /tmp/ohb-e2e-yolo-after-${lab.tag}.md avec le seul mot bonjour. Appelle l'outil directement.`,
        }, 202);
        const gate = await poll(async () => {
          const [first] = await gatesOf(lab, runId);
          if (first) return first;
          const run = await lab.run(runId);
          return run && ["completed", "failed", "cancelled"].includes(run.status) ? { id: "", decisionState: null, toolKey: null } : null;
        }, GATE_WAIT_MS);
        if (!gate) throw new Error("The run neither raised a gate nor ended.");
        if (!gate.id) {
          if (await calledWrite(lab, runId)) throw new Error("A write passed without a gate after the lease elapsed.");
          return warn("The model ended its turn without calling write_file.", { runId });
        }
        if (gate.decisionState === "awaiting_human") {
          pending = gate.id;
          await session.api("POST", `/api/approvals/${gate.id}/respond`, { choice: "deny" }, 202);
          pending = null;
        }
        await lab.follow(runId, t0);
        return { runId, decision: gate.decisionState, toolKey: gate.toolKey };
      });
    } finally {
      const open = pending as string | null;
      if (open) await session.raw("POST", `/api/approvals/${open}/respond`, { choice: "deny" }).catch(() => undefined);
      for (const leaseId of granted) await session.raw("DELETE", `/api/organization/yolo/leases/${leaseId}`).catch(() => undefined);
    }
  },
};
