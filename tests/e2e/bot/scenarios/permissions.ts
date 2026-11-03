/**
 * PERM2-A (DEV-OHB-250): a gate raised by the host approval plugin reaches
 * openedbot identified (tool key, descriptor, Hermes request id), and the answer
 * resolves that exact gate. The bot asks for a `write_file`; the answer is
 * `deny`, so the pass leaves no file on the runtime. Whether the model calls
 * the tool at all is its choice: no gate is a warning, a gate that arrives
 * unidentified is a failure.
 *
 * PERM2-1 (DEV-OHB-251): when the organization is in the `v2` pipeline, the
 * same pass also proves who answered. The manual gate is a human's
 * (`awaiting_human`, then `member`); in `bypass` a write to `/tmp` inside the
 * non-persistent terminal container is answered `once` by the policy without
 * a card, and a write under `.ssh` stays at the floor for a human, who
 * refuses it. Nothing persistent is left on the runtime.
 *
 * PERM2-4 (DEV-OHB-254): a manual gate offers no "Always" (the pipeline
 * sends every manual gate to a person before the grant stage, spec section
 * 5 step 5). On a fresh `auto` bot whose gate reaches a person, the card
 * offers "Always for this tool"; the next gate of that tool is answered
 * `once` at the grant stage without a card, and the grant is revoked before
 * the bot is purged.
 *
 * PERM2-7 (DEV-OHB-258): once the runtime's review profile is proven, a new
 * bot without an explicit mode starts in `auto` (D-1), and an `auto` gate is
 * answered by the reviewer on the bot's model, or handed to a person with
 * its reason, within the 15 s budget. The write targets `/tmp` in the
 * non-persistent terminal container.
 */
import type { ApprovalRespondDto, BotDto, BotPermissionGrantDto, RuntimeGatewayRestartDto } from "@openedbot/contracts-api";
import { Skip, warn } from "../kit/report";
import type { Scenario } from "../kit/scenario";

type GateRow = {
  id: string;
  hermesRequestId: string | null;
  gateKind: string;
  toolKey: string | null;
  gateArgs: { deletes?: string; opaque?: boolean; args?: Record<string, unknown> } | null;
  descriptorVersion: number | null;
  description: string | null;
  forwardState: string;
  decisionState: string | null;
  decisionStage: string | null;
  decidedByKind: string | null;
  selectedChoice: string | null;
};

const GATE_WAIT_MS = 120_000;

type Lab = Parameters<Scenario["run"]>[0]["lab"];

/** The first gate of a run, or `null` once the run ended without one. */
async function waitGate(lab: Lab, runId: string, t0: number): Promise<GateRow | null> {
  const deadline = t0 + GATE_WAIT_MS;
  while (Date.now() < deadline) {
    const rows = await lab.db<GateRow[]>`
      select id, hermes_request_id as "hermesRequestId", gate_kind as "gateKind", tool_key as "toolKey",
             gate_args as "gateArgs", descriptor_version as "descriptorVersion", description,
             forward_state as "forwardState", decision_state as "decisionState",
             decision_stage as "decisionStage", decided_by_kind as "decidedByKind",
             selected_choice as "selectedChoice"
        from approval_requests where run_id = ${runId} order by gate_ordinal limit 1`;
    if (rows[0]) return rows[0];
    const run = await lab.run(runId);
    if (run && ["completed", "failed", "cancelled", "unknown"].includes(run.status)) return null;
    await Bun.sleep(500);
  }
  return null;
}

/** PERM2-2: no v2 run starts before the bot's host policy is proven in force. */
async function waitPolicyEffective(lab: Lab, botId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [policy] = await lab.db<Array<{ at: Date | null }>>`select approval_policy_effective_at as at from bots where id = ${botId}`;
    if (policy?.at) return;
    if (Date.now() > deadline) throw new Error("The host policy of the bot was never proven in force.");
    await Bun.sleep(1_000);
  }
}

/**
 * A turn that raised no gate. A run that failed is a failure, never the
 * model's choice; a completed one is a reservation that quotes the reply.
 */
async function noGate(lab: Lab, runId: string, t0: number, detail: Record<string, unknown> = {}) {
  const turn = await lab.follow(runId, t0);
  const output = typeof turn.run?.output === "string" ? turn.run.output : JSON.stringify(turn.run?.output ?? null);
  if (turn.run?.status !== "completed") throw new Error(`The run ended ${String(turn.run?.status)} before any gate: ${output.slice(0, 300)}`);
  return warn("The model ended its turn without calling a gated tool.", { ...detail, runId, reply: output.slice(0, 200) });
}

/**
 * A fresh writer bot: the file toolset on, its plugin loaded, its host
 * policy proven. Its thread holds no earlier refusal the model would
 * remember (a model that saw denials may decline to call the tool again).
 */
async function freshWriter(
  { lab, session, model, config }: Pick<Parameters<Scenario["run"]>[0], "lab" | "session" | "model" | "config">,
  name: string,
  permissionMode?: BotDto["permissionMode"],
): Promise<BotDto> {
  const created = await lab.create({
    name, description: name, mission: "Écrire des notes quand on le demande.", locale: config.locale,
    ...(permissionMode ? { permissionMode } : {}),
  });
  await lab.setModel(created, model);
  const file = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${created.id}/capabilities/toolsets/file`, { enabled: true });
  if (!file.enabled || !file.applied) throw new Error("The host did not confirm the file toolset.");
  await restartGatewayIfPending(session);
  await waitPolicyEffective(lab, created.id);
  return created;
}

/** The "Always" the thread offers on this gate's card (`alwaysOffered`), `null` for none. */
async function offeredAlways(session: Parameters<Scenario["run"]>[0]["session"], threadId: string, approvalId: string) {
  const thread = await session.api<{ approvals: Array<{ id: string; alwaysOffered?: string | null }> }>("GET", `/api/threads/${threadId}`);
  return thread.approvals.find((row) => row.id === approvalId)?.alwaysOffered ?? null;
}

/** Whether the bot's runtime holds a proven review profile (PERM2-7a). */
async function reviewProfile(lab: Lab, botId: string): Promise<string> {
  const [proof] = await lab.db<Array<{ status: string }>>`
    select p.status from runtime_review_profiles p join bots b on b.organization_id = p.organization_id
      join runtimes r on r.id = p.runtime_id and r.is_active
     where b.id = ${botId}`;
  return proof?.status ?? "absent";
}

/** Loads a plugin a new profile installed: the gateway restart the owner would click. */
async function restartGatewayIfPending(session: Parameters<Scenario["run"]>[0]["session"]) {
  const status = await session.api<{ restartPending: boolean }>("GET", "/api/runtime/integrations/gateway");
  if (!status.restartPending) return { restarted: false, step: "none" };
  let job = await session.api<RuntimeGatewayRestartDto>("POST", "/api/runtime/integrations/gateway/restart", undefined, 202);
  const deadline = Date.now() + 180_000;
  while (job.status === "running" && Date.now() < deadline) {
    await Bun.sleep(1_000);
    job = await session.api<RuntimeGatewayRestartDto>("GET", `/api/runtime/integrations/gateway/restart/${job.jobId}`);
  }
  if (job.status !== "ok") throw new Error(`The gateway restart ended ${job.status} (${String(job.error)}).`);
  return { restarted: true, step: job.step };
}

export const permissions: Scenario = {
  id: "permissions",
  title: "Gate identifiée",
  summary: "Une écriture demandée par le bot pose une gate identifiée (outil, descripteur, request_id Hermes), et le refus tranche exactement cette gate.",
  async run({ lab, session, rec, model, config }) {
    let bot!: BotDto;
    let runId = "";
    let gate: GateRow | null = null;
    let answered = false;
    let pipeline = "legacy";
    // A gate a later step opened and has not answered yet.
    let pending: string | null = null;
    try {
      await rec.step("Bot en mode manuel", async () => {
        if (!session.hasFeature("approval_policy") || !session.hasFeature("profile_management")) throw new Skip("host without approval_policy or profile_management");
        bot = await lab.create({ name: "E2E Gate", description: "Gate d'approbation", mission: "Écrire des notes quand on le demande.", locale: config.locale, permissionMode: "manual" });
        await lab.setModel(bot, model);
        const [row] = await lab.db<Array<{ mode: string | null }>>`select approval_policy_mode as mode from bots where id = ${bot.id}`;
        if (row?.mode !== "ask_writes") throw new Error(`The host policy reads ${String(row?.mode)}, not ask_writes.`);
        // `write_file` lives in the `file` toolset, off on a fresh profile.
        const file = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${bot.id}/capabilities/toolsets/file`, { enabled: true });
        if (!file.enabled || !file.applied) throw new Error("The host did not confirm the file toolset.");
        const [flag] = await lab.db<Array<{ pipeline: string }>>`
          select o.permission_pipeline as pipeline from bots b join organizations o on o.id = b.organization_id where b.id = ${bot.id}`;
        pipeline = flag?.pipeline ?? "legacy";
        return { profile: bot.hermesProfile, policy: row.mode, fileToolset: file.enabled, pipeline };
      });

      await rec.step("Plugin chargé (redémarrage du gateway)", async () => {
        const restart = await restartGatewayIfPending(session);
        if (pipeline === "v2") await waitPolicyEffective(lab, bot.id);
        return restart;
      });

      await rec.step("Gate identifiée", async () => {
        const t0 = Date.now();
        ({ runId } = await session.api<{ runId: string }>("POST", `/api/threads/${bot.threadId}/messages`, {
          input: `Utilise l'outil write_file pour créer le fichier notes/e2e-${lab.tag}.md avec le seul mot bonjour. Appelle l'outil directement.`,
        }, 202));
        gate = await waitGate(lab, runId, t0);
        if (!gate) return noGate(lab, runId, t0);
        if (!gate.hermesRequestId) throw new Error("The gate carries no Hermes request_id.");
        if (gate.gateKind !== "plugin_tool" || !gate.toolKey || gate.descriptorVersion !== 1) {
          throw new Error(`The gate reads ${gate.gateKind}/${String(gate.toolKey)}, not an identified plugin gate.`);
        }
        if (gate.description?.includes("ohb-gate/")) throw new Error("The descriptor line reached the displayed description.");
        if (pipeline === "v2" && (gate.decisionState !== "awaiting_human" || gate.decidedByKind !== null)) {
          throw new Error(`A manual v2 gate reads ${String(gate.decisionState)}/${String(gate.decidedByKind)}, not awaiting_human for a person.`);
        }
        // A manual gate never reads a grant: its card offers no "Always".
        const always = await offeredAlways(session, bot.threadId, gate.id);
        if (always !== null) throw new Error(`A manual gate offers "${always}", which the pipeline would never read.`);
        return {
          toolKey: gate.toolKey, deletes: gate.gateArgs?.deletes ?? null, opaque: gate.gateArgs?.opaque ?? null,
          decisionState: gate.decisionState, decisionStage: gate.decisionStage, gateMs: Date.now() - t0,
        };
      });

      await rec.step("Refus de cette gate", async () => {
        if (!gate) throw new Skip("no gate to answer");
        await session.api("POST", `/api/approvals/${gate.id}/respond`, { choice: "deny" }, 202);
        answered = true;
        const turn = await lab.follow(runId, Date.now());
        const [after] = await lab.db<Array<{ forwardState: string; decisionState: string | null; decidedByKind: string | null }>>`
          select forward_state as "forwardState", decision_state as "decisionState", decided_by_kind as "decidedByKind"
            from approval_requests where id = ${gate.id}`;
        if (after?.forwardState !== "confirmed") throw new Error(`The answer was not confirmed by Hermes (forward_state ${String(after?.forwardState)}).`);
        if (pipeline === "v2" && (after.decisionState !== "decided" || after.decidedByKind !== "member")) {
          throw new Error(`The answered v2 gate reads ${String(after.decisionState)}/${String(after.decidedByKind)}, not decided by a member.`);
        }
        const responded = await lab.db<Array<{ choice: string | null }>>`
          select payload->>'choice' as choice from run_events where run_id = ${runId} and type = 'approval.responded'`;
        if (!responded.some((event) => event.choice === "deny")) throw new Error("Hermes never confirmed the deny on this run.");
        if (turn.run?.status !== "completed") throw new Error(`The run ended ${String(turn.run?.status)} after the deny.`);
        if (!(await lab.answered(bot.threadId, runId))) throw new Error("No non-empty assistant reply reads back in the thread.");
        return { forwardState: after.forwardState, run: turn.run.status, decidedBy: after.decidedByKind };
      });

      await rec.step("v2 : accès complet, la politique répond", async () => {
        if (pipeline !== "v2") throw new Skip("organization in the legacy pipeline");
        const patched = await session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, { permissionMode: "bypass" });
        if (patched.permissionMode !== "bypass") throw new Error(`The bot mode reads ${String(patched.permissionMode)}, not bypass.`);
        const [row] = await lab.db<Array<{ mode: string | null }>>`select approval_policy_mode as mode from bots where id = ${bot.id}`;
        if (row?.mode !== "ask_writes") throw new Error(`A v2 bypass bot reads host policy ${String(row?.mode)}, not ask_writes.`);
        const t0 = Date.now();
        const sent = await session.api<{ runId: string }>("POST", `/api/threads/${bot.threadId}/messages`, {
          input: `Utilise l'outil write_file pour créer le fichier /tmp/ohb-e2e-${lab.tag}.md avec le seul mot bonjour. Appelle l'outil directement.`,
        }, 202);
        const policyGate = await waitGate(lab, sent.runId, t0);
        if (!policyGate) return noGate(lab, sent.runId, t0);
        if (policyGate.decidedByKind !== "policy" || policyGate.selectedChoice !== "once" || policyGate.decisionStage !== "full") {
          if (policyGate.decisionState === "awaiting_human") pending = policyGate.id;
          throw new Error(`The bypass gate reads ${String(policyGate.decidedByKind)}/${String(policyGate.selectedChoice)}/${String(policyGate.decisionStage)}, not a policy once at the full stage.`);
        }
        const turn = await lab.follow(sent.runId, t0);
        const [after] = await lab.db<Array<{ forwardState: string }>>`select forward_state as "forwardState" from approval_requests where id = ${policyGate.id}`;
        if (after?.forwardState !== "confirmed") throw new Error(`The policy answer was not confirmed by Hermes (forward_state ${String(after?.forwardState)}).`);
        if (turn.run?.status !== "completed") throw new Error(`The run ended ${String(turn.run?.status)} after the policy answer.`);
        return { stage: policyGate.decisionStage, decidedBy: policyGate.decidedByKind, forwardState: after.forwardState, gateMs: Date.now() - t0 };
      });

      await rec.step("v2 : le plancher tient en accès complet", async () => {
        if (pipeline !== "v2") throw new Skip("organization in the legacy pipeline");
        const t0 = Date.now();
        const sent = await session.api<{ runId: string }>("POST", `/api/threads/${bot.threadId}/messages`, {
          input: `Utilise l'outil write_file pour créer le fichier .ssh/ohb-e2e-${lab.tag} avec le seul mot bonjour. Appelle l'outil directement.`,
        }, 202);
        const floorGate = await waitGate(lab, sent.runId, t0);
        if (!floorGate) return noGate(lab, sent.runId, t0);
        if (floorGate.decisionState !== "awaiting_human") {
          throw new Error(`A .ssh write in bypass reads ${String(floorGate.decisionState)}/${String(floorGate.decisionStage)}, not awaiting a human.`);
        }
        pending = floorGate.id;
        await session.api("POST", `/api/approvals/${floorGate.id}/respond`, { choice: "deny" }, 202);
        pending = null;
        const turn = await lab.follow(sent.runId, t0);
        if (turn.run?.status !== "completed") throw new Error(`The run ended ${String(turn.run?.status)} after the deny.`);
        return { stage: floorGate.decisionStage, run: turn.run.status };
      });

      await rec.step("v2 : « Toujours » pour cet outil", async () => {
        if (pipeline !== "v2") throw new Skip("organization in the legacy pipeline");
        // Only `auto` and `bypass` read a grant, and a `bypass` gate never
        // reaches a person outside the floor: the card is an `auto` one, held
        // for a person by the reviewer (`review_runtime_busy` on a gateway of
        // one slot, or the reviewer's own escalation).
        const profile = await reviewProfile(lab, bot.id);
        if (profile !== "proven") throw new Skip(`review profile ${profile} on this runtime: auto is manual here`);
        // The gate bot's thread already holds two refusals: a fresh bot.
        const always = await freshWriter({ lab, session, model, config }, "E2E Toujours", "auto");
        if (always.permissionMode !== "auto") throw new Error(`The bot mode reads ${String(always.permissionMode)}, not auto.`);
        const t0 = Date.now();
        const first = await session.api<{ runId: string }>("POST", `/api/threads/${always.threadId}/messages`, {
          input: `Utilise l'outil write_file pour créer le fichier /tmp/ohb-e2e-always-${lab.tag}.md avec le seul mot bonjour. Appelle l'outil directement.`,
        }, 202);
        const asked = await waitGate(lab, first.runId, t0);
        if (!asked) return noGate(lab, first.runId, t0);
        let state = asked.decisionState;
        while (state === "reviewing" && Date.now() - t0 < GATE_WAIT_MS) {
          await Bun.sleep(250);
          const [row] = await lab.db<Array<{ state: string | null }>>`select decision_state as state from approval_requests where id = ${asked.id}`;
          state = row?.state ?? null;
        }
        if (state !== "awaiting_human") {
          // The reviewer answered by itself: no card, nothing to click.
          const turn = await lab.follow(first.runId, t0);
          if (turn.run?.status !== "completed") throw new Error(`The run ended ${String(turn.run?.status)} after the review.`);
          return warn("The reviewer answered the gate itself: no card offered an Always.", { state });
        }
        pending = asked.id;
        const offered = await offeredAlways(session, always.threadId, asked.id);
        if (offered !== "always_bot_tool") throw new Error(`An auto gate held for a person offers ${String(offered)}, not always_bot_tool.`);
        const answer = await session.api<ApprovalRespondDto>("POST", `/api/approvals/${asked.id}/respond`, { choice: "always_bot_tool" }, 202);
        pending = null;
        if (answer.always?.saved !== true) throw new Error(`The grant was not saved (${String(answer.always?.error)}).`);
        const firstTurn = await lab.follow(first.runId, t0);
        if (firstTurn.run?.status !== "completed") throw new Error(`The run ended ${String(firstTurn.run?.status)} after "Always".`);
        const grants = await session.api<BotPermissionGrantDto[]>("GET", `/api/bots/${always.id}/permission-grants`);
        const grant = grants.find((row) => row.toolKey === asked.toolKey);
        if (!grant || grant.createdFromApprovalId !== asked.id) throw new Error(`No active grant for ${String(asked.toolKey)} reads back from the gate.`);

        const t1 = Date.now();
        const second = await session.api<{ runId: string }>("POST", `/api/threads/${always.threadId}/messages`, {
          input: `Utilise encore l'outil write_file pour créer le fichier /tmp/ohb-e2e-always-2-${lab.tag}.md avec le seul mot bonjour. Appelle l'outil directement.`,
        }, 202);
        const granted = await waitGate(lab, second.runId, t1);
        let grantedStage: string | null = null;
        if (granted) {
          if (granted.decisionState === "awaiting_human" || granted.decisionState === "reviewing") pending = granted.id;
          if (granted.decidedByKind !== "policy" || granted.selectedChoice !== "once" || granted.decisionStage !== "grant") {
            throw new Error(`The granted gate reads ${String(granted.decidedByKind)}/${String(granted.selectedChoice)}/${String(granted.decisionStage)}, not a policy once at the grant stage.`);
          }
          grantedStage = granted.decisionStage;
          const secondTurn = await lab.follow(second.runId, t1);
          if (secondTurn.run?.status !== "completed") throw new Error(`The run ended ${String(secondTurn.run?.status)} under the grant.`);
        }
        const unanswered = granted ? null : await noGate(lab, second.runId, t1);

        await session.api("POST", `/api/bots/${always.id}/permission-grants/${grant.id}/revoke`, { reason: "Fin de la passe e2e" }, 204);
        const left = await session.api<BotPermissionGrantDto[]>("GET", `/api/bots/${always.id}/permission-grants`);
        if (left.some((row) => row.id === grant.id)) throw new Error("The revoked grant still reads as active.");
        const detail = { toolKey: grant.toolKey, grantedStage, revoked: true };
        return unanswered ? warn(unanswered.note, { ...detail, ...unanswered.detail }) : detail;
      });

      await rec.step("v2 : revue auto", async () => {
        if (pipeline !== "v2") throw new Skip("organization in the legacy pipeline");
        const profile = await reviewProfile(lab, bot.id);
        if (profile !== "proven") throw new Skip(`review profile ${profile} on this runtime`);
        const configuration = await session.api<{ defaultPermissionMode?: string }>("GET", "/api/runtime");
        if (configuration.defaultPermissionMode !== "auto") throw new Error(`D-1: a proven review gives the default ${String(configuration.defaultPermissionMode)}, not auto.`);
        // A fresh bot, created without a mode: D-1 makes it `auto`, and its
        // thread holds no earlier refusal the model would remember.
        const reviewed = await freshWriter({ lab, session, model, config }, "E2E Revue");
        if (reviewed.permissionMode !== "auto") throw new Error(`D-1: a bot created without a mode reads ${String(reviewed.permissionMode)}, not auto.`);
        const t0 = Date.now();
        const sent = await session.api<{ runId: string }>("POST", `/api/threads/${reviewed.threadId}/messages`, {
          input: `Utilise l'outil write_file pour créer le fichier /tmp/ohb-e2e-review-${lab.tag}.md avec le seul mot bonjour, c'est ce que je te demande. Appelle l'outil directement.`,
        }, 202);
        const reviewGate = await waitGate(lab, sent.runId, t0);
        if (!reviewGate) return noGate(lab, sent.runId, t0);
        const born = Date.now();
        let row: { state: string | null; stage: string | null; kind: string | null; choice: string | null; detail: Record<string, unknown> | null } | undefined;
        while (Date.now() - born < 20_000) {
          [row] = await lab.db<Array<{ state: string | null; stage: string | null; kind: string | null; choice: string | null; detail: Record<string, unknown> | null }>>`
            select decision_state as state, decision_stage as stage, decided_by_kind as kind, selected_choice as choice, decision_detail as detail
              from approval_requests where id = ${reviewGate.id}`;
          if (row?.state !== "reviewing") break;
          await Bun.sleep(250);
        }
        const decidedMs = Date.now() - born;
        if (!row || row.state === "reviewing") throw new Error("The gate is still under review after 20 s.");
        if (row.stage !== "review") throw new Error(`The auto gate was decided at stage ${String(row.stage)}, not by the review.`);
        const reason = String(row.detail?.reason ?? "");
        if (row.state === "awaiting_human") {
          pending = reviewGate.id;
          await session.api("POST", `/api/approvals/${reviewGate.id}/respond`, { choice: "deny" }, 202);
          pending = null;
        } else if (row.kind !== "policy" || !["once", "deny"].includes(String(row.choice))) {
          throw new Error(`The reviewed gate reads ${String(row.kind)}/${String(row.choice)}.`);
        }
        const turn = await lab.follow(sent.runId, t0);
        if (turn.run?.status !== "completed") throw new Error(`The run ended ${String(turn.run?.status)} after the review.`);
        const outcome = row.state === "awaiting_human" ? "human" : String(row.choice);
        const reviewerReason = typeof row.detail?.reviewerReason === "string" ? row.detail.reviewerReason : null;
        const detail = { outcome, reason, reviewerReason, decidedMs, model: model.model };
        // A person answering is the safe ending, not a failure; it is reported.
        if (reason !== "review_approve" && reason !== "review_deny") return warn(`The reviewer handed the gate to a person (${reason}).`, detail);
        return detail;
      });
    } finally {
      // An open gate makes the bot purge answer 409: never leave one behind.
      // `gate` is written inside the step callbacks, out of the narrowing's sight.
      const open = gate as GateRow | null;
      if (open && !answered) await session.raw("POST", `/api/approvals/${open.id}/respond`, { choice: "deny" }).catch(() => undefined);
      const later = pending as string | null;
      if (later) await session.raw("POST", `/api/approvals/${later}/respond`, { choice: "deny" }).catch(() => undefined);
    }
  },
};
