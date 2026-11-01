import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BOT_TOOL_POLICY_VALUES, canOperateWorkspace, isBotToolPolicyAlwaysRefused, type BotDto, type BotPermissionGrantDto, type BotToolPoliciesDto, type BotToolPolicyValue } from "@openedbot/contracts-api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, errorMessage, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { toolPolicyGroups, type ToolPolicyGroup, type ToolPolicyRow } from "../../lib/tool-policy-groups";
import { BUTTON, ListRow, ListRowsSkeleton, ListSection, Note } from "../settings/primitives";

/**
 * PERM2-5: one selector per gated tool, written on change like the mode
 * above it (no draft). A tool without a stored value follows the mode.
 *
 * PERM2-4: the permanent "Always" grants chosen from a gate card show on the
 * row of their tool, with their revoke button. No expiry (D-4): they leave
 * only here. A revocation counts from the bot's next gate on.
 */
export function BotToolPolicies({ bot }: { bot: BotDto }) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  const policies = useQuery({ queryKey: queryKeys.botToolPolicies(bot.id), queryFn: () => api.botToolPolicies(bot.id) });
  const capabilities = useQuery({ queryKey: queryKeys.botCapabilities(bot.id), queryFn: () => api.botCapabilities(bot.id) });
  const write = useMutation({
    mutationFn: (entry: { toolKey: string; policy: BotToolPolicyValue }) => api.setBotToolPolicies(bot.id, [entry]),
    onSuccess: async (next: BotToolPoliciesDto) => {
      queryClient.setQueryData(queryKeys.botToolPolicies(bot.id), next);
      // The host proof moved: the roster says whether the bot may run.
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botManage.toolPolicies.saveFailed")),
  });

  // The grant routes require an operator (owner, admin, agency); a member sees no grant line.
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const operator = canOperateWorkspace(me.data?.session.role ?? "");
  const grants = useQuery({ queryKey: queryKeys.botPermissionGrants(bot.id), queryFn: () => api.botPermissionGrants(bot.id), enabled: operator });
  const revoke = useMutation({
    mutationFn: (grant: BotPermissionGrantDto) => api.revokeBotPermissionGrant(bot.id, grant.id),
    onSuccess: (_result, grant) => toast.success(t("botManage.grantRevoked", { tool: grant.toolKey })),
    onError: (error) => toast.error(errorMessage(error, t("botManage.grantRevokeFailed"))),
    // A grant already revoked elsewhere answers 404: the list is re-read either way.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.botPermissionGrants(bot.id) }),
  });

  const grantList = operator ? grants.data ?? [] : [];
  const grantByTool = new Map<string, BotPermissionGrantDto>(grantList.map((grant) => [grant.toolKey, grant]));
  const grantMeta = (grant: BotPermissionGrantDto) => grant.createdByName
    ? t("botManage.toolPolicies.grantActive", { name: grant.createdByName, date: formatDate(grant.createdAt) })
    : t("botManage.toolPolicies.grantActiveAnonymous", { date: formatDate(grant.createdAt) });
  // Revocation stays open to every operator, whatever the writable/enforced state of the selectors.
  const grantLine = (grant: BotPermissionGrantDto, label: string, overridden: "ask" | "block" | null) => (
    <div className="mt-1 flex w-full basis-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-tool-grant="">
      <p className="min-w-0 flex-1 text-xs leading-5 text-text-tertiary [overflow-wrap:anywhere]">
        {grantMeta(grant)}
        {overridden ? <> {t("botManage.toolPolicies.grantOverridden", { policy: t(`botManage.toolPolicies.value.${overridden}`) })}</> : null}
      </p>
      <button
        type="button"
        className={`${BUTTON.small} min-h-11 sm:min-h-0`}
        aria-label={t("botManage.toolPolicies.grantRevokeLabel", { tool: label })}
        disabled={revoke.isPending}
        onClick={() => revoke.mutate(grant)}
      >
        {t("botManage.grantRevoke")}
      </button>
    </div>
  );
  const grantSection = (list: BotPermissionGrantDto[]) => list.length > 0 ? (
    <ListSection title={t("botManage.toolPolicies.familyGranted")}>
      {list.map((grant) => (
        <ListRow key={grant.id} label={<span className="font-mono text-[13px] font-normal">{grant.toolKey}</span>} stacked>
          {grantLine(grant, grant.toolKey, null)}
        </ListRow>
      ))}
    </ListSection>
  ) : null;
  const grantsFailed = operator && grants.isError ? <Note tone="warning">{t("botManage.toolPolicies.grantsLoadFailed")}</Note> : null;

  const title = t("botManage.toolPolicies.title");
  if (policies.isError) {
    // The grants stay revocable even when the per-tool settings cannot be read.
    return (
      <div className="space-y-3" data-tool-policies="">
        <Note tone="warning">{t("botManage.toolPolicies.readFailed")}</Note>
        {grantsFailed}
        {grantSection(grantList)}
      </div>
    );
  }
  if (!policies.data) {
    return <ListSection title={title}><ListRowsSkeleton label={title} rows={3} /></ListSection>;
  }
  const view = policies.data;
  const disabled = !view.writable || !view.enforced || write.isPending;
  const groups = toolPolicyGroups(view.policies, capabilities.data?.mcpServers ?? null);
  const groupTitle = (group: ToolPolicyGroup) => group.kind === "native"
    ? t("botManage.toolPolicies.familyNative")
    : group.kind === "mcp" ? t("botManage.toolPolicies.familyMcp", { name: group.server }) : t("botManage.toolPolicies.familyOther");
  const rowLabel = (row: ToolPolicyRow) => (row.native ? t(`botManage.toolPolicies.tool.${row.label as "write_file"}`) : row.label);
  const rowKeys = new Set(groups.flatMap((group) => group.rows.map((row) => row.toolKey)));
  const familyGrants = grantList.filter((grant) => !rowKeys.has(grant.toolKey));

  return (
    <div className="space-y-3" data-tool-policies="">
      <p className="text-xs leading-5 text-text-tertiary">{t("botManage.toolPolicies.intro")}</p>
      {!view.enforced ? <Note tone="info">{t("botManage.toolPolicies.notEnforced")}</Note> : null}
      {view.enforced && !view.writable ? <Note tone="neutral">{t("botManage.toolPolicies.readOnly")}</Note> : null}
      {view.hostBlocked === "pending" && view.policies.some((entry) => entry.policy === "block") ? (
        <p role="status" className="text-xs leading-5 text-text-secondary">{t("botManage.toolPolicies.hostPending")}</p>
      ) : null}
      {grantsFailed}
      {groups.map((group) => (
        <ListSection key={group.kind === "mcp" ? `mcp:${group.server}` : group.kind} title={groupTitle(group)}>
          {group.rows.length === 0 ? (
            <ListRow label={t("botManage.toolPolicies.mcpNoTools")} />
          ) : group.rows.map((row) => (
            <ListRow key={row.toolKey} label={rowLabel(row)} description={row.native ? undefined : row.toolKey} stacked>
              <Select
                value={row.policy}
                disabled={disabled}
                onValueChange={(value) => {
                  if ((BOT_TOOL_POLICY_VALUES as readonly string[]).includes(value) && value !== row.policy) {
                    write.mutate({ toolKey: row.toolKey, policy: value as BotToolPolicyValue });
                  }
                }}
              >
                <SelectTrigger className="min-w-44" aria-label={t("botManage.toolPolicies.selectLabel", { tool: rowLabel(row) })}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOT_TOOL_POLICY_VALUES.map((value) => (
                    <SelectItem key={value} value={value} disabled={value === "always" && isBotToolPolicyAlwaysRefused(row.toolKey) && row.policy !== "always"}>
                      {t(`botManage.toolPolicies.value.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isBotToolPolicyAlwaysRefused(row.toolKey) ? (
                <p className="mt-1 text-xs leading-5 text-text-tertiary">{t("botManage.toolPolicies.alwaysUnavailable")}</p>
              ) : null}
              {grantByTool.has(row.toolKey)
                ? grantLine(grantByTool.get(row.toolKey)!, rowLabel(row), row.policy === "ask" || row.policy === "block" ? row.policy : null)
                : null}
            </ListRow>
          ))}
        </ListSection>
      ))}
      {grantSection(familyGrants)}
      <p className="text-xs leading-5 text-text-tertiary">{t("botManage.toolPolicies.uncovered")}</p>
    </div>
  );
}
