import type { DecisionDto, DecisionTraceDto, DecisionTraceGrantDto } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../../lib/i18n";

type Translate = ReturnType<typeof useT>["t"];
type FormatDate = ReturnType<typeof useT>["formatDate"];

const DAY: Intl.DateTimeFormatOptions = { dateStyle: "medium" };

function stageLabel(stage: DecisionTraceDto["stage"], t: Translate): string | null {
  return stage ? t(`decisions.trace.stage.${stage}`) : null;
}

function reasonLabel(reason: DecisionTraceDto["reason"], t: Translate): string | null {
  return reason ? t(`decisions.trace.reason.${reason}`) : null;
}

function deciderLine(decision: DecisionDto, trace: DecisionTraceDto, t: Translate): string | null {
  if (trace.decidedBy === "policy" || (decision.origin === "policy" && trace.decidedBy === null)) {
    const stage = stageLabel(trace.stage, t);
    return stage ? t("decisions.trace.decidedByPolicy", { stage }) : null;
  }
  if (trace.decidedBy === "member") {
    return trace.deciderName ? t("decisions.trace.decidedByMember", { name: trace.deciderName }) : t("decisions.trace.decidedBySomeMember");
  }
  // A human answer from before the trace: the person is still known.
  return trace.deciderName ? t("decisions.trace.decidedByMember", { name: trace.deciderName }) : null;
}

function grantLine(grant: DecisionTraceGrantDto, t: Translate, formatDate: FormatDate): string {
  const date = grant.createdAt ? formatDate(grant.createdAt, DAY) : null;
  let line: string;
  if (grant.kind === "bot_tool") {
    line = grant.authorName && date
      ? t(grant.fromAlways ? "decisions.trace.grantAlways" : "decisions.trace.grantBy", { name: grant.authorName, date })
      : t("decisions.trace.grantUnknownAuthor");
  } else {
    line = grant.authorName && date
      ? t(grant.fromAlways ? "decisions.trace.switchAlways" : "decisions.trace.switchBy", { name: grant.authorName, date })
      : t("decisions.trace.switchUnknownAuthor");
  }
  return grant.revoked ? `${line} (${t("decisions.trace.revoked")})` : line;
}

/**
 * PERM2-11: who or what decided a gate of the journal, and why, in the
 * product's own words. Every line comes from a closed code the API already
 * bounded: never the command beyond the action column, never gate arguments.
 */
export function decisionTraceLines(decision: DecisionDto, t: Translate, formatDate: FormatDate): string[] {
  const trace = decision.trace;
  if (!trace) return [];
  const lines: string[] = [];
  const decider = deciderLine(decision, trace, t);
  if (decider) lines.push(decider);

  const human = trace.decidedBy === "member" || decision.origin === "human";
  const reason = reasonLabel(trace.reason, t);
  if (trace.stage === "unattended") {
    const held = trace.heldBy ? reasonLabel(trace.heldBy.reason, t) ?? stageLabel(trace.heldBy.stage, t) : null;
    lines.push(held ? t("decisions.trace.heldBy", { reason: held }) : t("decisions.trace.because", { reason: t("decisions.trace.reason.never_wait") }));
  } else if (human) {
    const why = reason ?? stageLabel(trace.stage, t);
    if (why) lines.push(t("decisions.trace.askedBecause", { reason: why }));
  } else if (reason) {
    lines.push(t("decisions.trace.because", { reason }));
  } else if (trace.stage) {
    lines.push(t("decisions.trace.unknown"));
  }

  if (trace.grant) lines.push(grantLine(trace.grant, t, formatDate));
  if (trace.always) {
    lines.push(!trace.always.saved
      ? t("decisions.trace.alwaysNotSaved")
      : trace.always.choice === "always_bot_tool" ? t("decisions.trace.alwaysSavedTool") : t("decisions.trace.alwaysSavedTerminal"));
  }
  const overridden = reasonLabel(trace.humanOverridden, t);
  if (overridden) lines.push(t("decisions.trace.humanOverridden", { reason: overridden }));
  if (trace.policyChanged) lines.push(t("decisions.trace.policyChanged"));
  return lines;
}

export function DecisionTrace({ decision, className }: { decision: DecisionDto; className?: string }) {
  const { t, formatDate } = useT();
  const lines = decisionTraceLines(decision, t, formatDate);
  if (lines.length === 0) return null;
  return (
    <ul data-decision-trace="" className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      {lines.map((line, index) => (
        <li key={index} className="break-words">{line}</li>
      ))}
    </ul>
  );
}
