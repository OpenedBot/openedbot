import { memo } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import type { WebSearchQuery } from "@openedbot/execution/domain/agent-web-search";
import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import { groupToolCalls, type ToolCall } from "@openedbot/conversation/domain/thread-tools";
import { GateCard } from "./gate-card";
import { ToolResult } from "./thread-tool-result";

export { partialFailureLabel } from "./thread-tool-labels";

/**
 * The tool work of one passage, as steps of the Agent Activity feed: one
 * Tool Result per group of consecutive calls of the same tool
 * (`groupToolCalls`: `terminal ×7`, never a call that carries its own
 * result), then the decisions the runtime asked right after them, in the
 * runtime's order.
 *
 * Each group and each decision is a row of the feed (`data-activity-row`):
 * a call that starts later in the same passage enters the feed on its own,
 * as the next row. A pending decision is never hidden in a fold: the turn
 * forces its activity open (`forceOpen`) and leaves it uncapped.
 */
export const ToolActivity = memo(function ToolActivity({
  entryKey,
  calls,
  searches,
  approvals,
  findTargetId,
  findActive = false,
  onSeeBotErrors,
}: {
  /**
   * The timeline entry's stable key (`runId:sequence`). `findTargetId` carries
   * the event cursor, which changes when a live event is persisted: a row
   * keyed on it would remount and lose the operator's open/closed choice.
   */
  entryKey: string;
  calls: readonly ToolCall[];
  /** The web search each call ran, aligned on `calls`: a search card tells its query and sources. */
  searches?: readonly (WebSearchQuery | null)[];
  /** Gates emitted just after these calls, in the runtime's order. */
  approvals: readonly ApprovalRequestDto[];
  findTargetId: string;
  findActive?: boolean;
  onSeeBotErrors?: () => void;
}) {
  const visible = calls.flatMap((call, index) => isTodoTool(call.tool) ? [] : [{ call, search: searches?.[index] ?? null }]);
  if (visible.length === 0 && approvals.length === 0) return null;
  const groups = groupToolCalls(visible.map(({ call }) => call));
  // A group is a run of consecutive calls: its searches are the same slice.
  let offset = 0;
  const groupSearches = groups.map((group) => {
    const slice = visible.slice(offset, offset + group.count).flatMap(({ search }) => search ? [search] : []);
    offset += group.count;
    return slice;
  });
  return (
    <div
      data-tool-activity=""
      data-thread-find-target={findTargetId}
      className={cn(
        "flex w-full min-w-0 max-w-full flex-col self-start",
        findActive && "rounded-lg ring-2 ring-primary ring-offset-2",
      )}
    >
      {groups.map((group, index) => (
        // Identity from the passage and the group's place, never from a
        // cursor: a group keeps its key while its calls append and persist.
        <div key={`${entryKey}:${index}`} role="listitem" data-activity-row="tool" className="min-w-0 px-1.5">
          <ToolResult group={group} searches={groupSearches[index]} approvals={approvals} onSeeBotErrors={onSeeBotErrors} />
        </div>
      ))}
      {approvals.map((approval) => (
        <div key={approval.id} role="listitem" data-activity-row="gate" className="min-w-0 px-1.5 py-1">
          <GateCard approval={approval} embedded mode="summary" />
        </div>
      ))}
    </div>
  );
});
