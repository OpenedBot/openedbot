import type { ToolKind } from "@openedbot/conversation/domain/thread-tools";
import type { useT } from "../lib/i18n";

type Translate = ReturnType<typeof useT>["t"];
type Plural = ReturnType<typeof useT>["plural"];

/** « 1 échec sur 2 »: the label of a group partially failed. */
export function partialFailureLabel(t: Translate, plural: Plural, failures: number, total: number): string {
  return plural(failures, {
    one: t("threadTimeline.toolPartialFailure_one", { count: failures, total }),
    other: t("threadTimeline.toolPartialFailure_other", { count: failures, total }),
  });
}

/** The order the folded summary names the families in: what the operator asked for first. */
const KIND_ORDER: readonly ToolKind[] = ["search", "web", "read", "edit", "run", "code", "delegate", "mcp", "other"];

const KIND_KEYS = {
  search: ["threadTimeline.activityKindSearch_one", "threadTimeline.activityKindSearch_other"],
  web: ["threadTimeline.activityKindWeb_one", "threadTimeline.activityKindWeb_other"],
  read: ["threadTimeline.activityKindRead_one", "threadTimeline.activityKindRead_other"],
  edit: ["threadTimeline.activityKindEdit_one", "threadTimeline.activityKindEdit_other"],
  run: ["threadTimeline.activityKindRun_one", "threadTimeline.activityKindRun_other"],
  code: ["threadTimeline.activityKindCode_one", "threadTimeline.activityKindCode_other"],
  delegate: ["threadTimeline.activityKindDelegate_one", "threadTimeline.activityKindDelegate_other"],
  mcp: ["threadTimeline.activityKindMcp_one", "threadTimeline.activityKindMcp_other"],
  other: ["threadTimeline.activityKindOther_one", "threadTimeline.activityKindOther_other"],
} as const satisfies Record<ToolKind, readonly [string, string]>;

/**
 * The folded Agent Activity line, by tool family: « 2 recherches web,
 * 1 lecture et 3 commandes » rather than « 6 outils ». The list joins with the
 * locale's own conjunction (`Intl.ListFormat`). A turn of unknown tools only
 * says how many tools it ran.
 */
export function activityKindSummary(
  t: Translate,
  plural: Plural,
  locale: string,
  counts: ReadonlyMap<ToolKind, number>,
): string | null {
  const known = KIND_ORDER.filter((kind) => kind !== "other" && (counts.get(kind) ?? 0) > 0);
  const others = counts.get("other") ?? 0;
  if (known.length === 0) {
    if (others === 0) return null;
    return plural(others, {
      one: t("threadTimeline.activityKindTool_one", { count: others }),
      other: t("threadTimeline.activityKindTool_other", { count: others }),
    });
  }
  const parts = [...known, ...(others > 0 ? ["other" as const] : [])].map((kind) => {
    const count = counts.get(kind) ?? 0;
    const [one, other] = KIND_KEYS[kind];
    return plural(count, { one: t(one, { count }), other: t(other, { count }) });
  });
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
}
