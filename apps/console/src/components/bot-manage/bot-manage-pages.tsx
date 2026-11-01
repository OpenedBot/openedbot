import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { effectiveBotPermission, type BotDto } from "@openedbot/contracts-api";
import {
  AUTONOMY_CEILINGS,
  AUTONOMY_MINIMUMS,
  normalizeAutonomyPolicy,
  type AutonomyPolicy,
} from "@openedbot/roster/domain/autonomous-workflow";
import { personaMetrics } from "@openedbot/roster/domain/persona";
import { Input, Label, Switch, toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";
import { PersonaEditor } from "../persona-editor";
import { SettingsToolCard } from "./bot-settings-tool-card";
import { BotToolPolicies } from "./bot-tool-policies";
import { GatewayRestartCard } from "../../screens/settings/installation/connectors-mcp";
import { ThreadModelPicker } from "../composer-model-picker";
import { PermissionModeList, usePermissionContext, useSetPermissionMode } from "../boardui/permission-picker";
import { ThreadActivityList } from "../thread-activity-panel";
import { BotPermissionRules, useHasProPermissions } from "../../pro-console/slots";

// The runtime pane is the whole `/settings/runtime` screen: loaded when opened.
export const CloudRuntimeSettings = lazy(() =>
  import("../../screens/settings/installation/cloud").then((module) => ({ default: module.CloudRuntimeSettings })));

export function RuntimePane() {
  return <Suspense fallback={null}><CloudRuntimeSettings /></Suspense>;
}

/**
 * The persona (SOUL) injected at the head of every run. Its own draft and its
 * own « Enregistrer »: leaving the page without saving drops the draft, the
 * bot keeps what it had.
 */
export function usePersonaPage(bot: BotDto, open: boolean) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(bot.instructions);
  useEffect(() => {
    if (open) setDraft(bot.instructions);
  }, [open, bot.id, bot.instructions]);
  const dirty = draft.trim() !== bot.instructions.trim();
  const save = useMutation({
    mutationFn: () => api.updateBot(bot.id, { instructions: draft.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      toast.success(t("botSettingsDialog.saveSuccess", { name: bot.name }));
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botSettingsDialog.saveFailed")),
  });
  const overLimit = personaMetrics(draft).overLimit;
  return {
    body: (
      <div className="space-y-4">
        <PersonaEditor botId={bot.id} value={draft} onChange={setDraft} />
        <SettingsToolCard bot={bot} open={open} />
      </div>
    ),
    footer: (
      <button type="button" className={BUTTON.primary} disabled={!dirty || overLimit || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? t("botSettingsDialog.saving") : t("botSettingsDialog.save")}
      </button>
    ),
  };
}

/** The bot's own model, written like the composer picker writes it. */
export function ModelPage({ bot }: { bot: BotDto }) {
  const { t } = useT();
  return (
    <div className="space-y-3">
      <p className="text-sm leading-5 text-text-secondary">{t("botManage.modelIntro")}</p>
      <div className="flex">
        <ThreadModelPicker bot={bot} variant="header" />
      </div>
      <p className="text-xs leading-5 text-text-tertiary">{t("botManage.modelHint")}</p>
    </div>
  );
}

/** Approval rules: a choice written on click (OpenBot `setup.tsx`), no draft. */
export function ApprovalsPage({ bot }: { bot: BotDto }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const setMode = useSetPermissionMode(bot.id);
  const current = bot.permissionMode ?? "manual";
  const context = usePermissionContext();
  const effective = effectiveBotPermission(current, context);
  const hasProPermissions = useHasProPermissions();
  // The worker proves the policy a moment after the restart (or after any
  // write): re-read the roster until it says the policy is in force.
  const policyPending = bot.hostPolicy === "pending";
  useEffect(() => {
    if (!policyPending) return;
    const timer = setInterval(() => void queryClient.invalidateQueries({ queryKey: queryKeys.roster }), 3_000);
    return () => clearInterval(timer);
  }, [policyPending, queryClient]);
  return (
    <div className="space-y-3">
      <p className="text-sm leading-5 text-text-secondary">{t("botManage.approvalsIntro")}</p>
      {policyPending ? (
        <div className="space-y-2" data-host-policy="pending">
          <p role="status" className="text-xs leading-5 text-text-secondary">{t("botManage.hostPolicyPending")}</p>
          <GatewayRestartCard onRestarted={() => void queryClient.invalidateQueries({ queryKey: queryKeys.roster })} />
        </div>
      ) : null}
      {effective.reason ? (
        <p role="status" data-permission-effective-note="" className="text-xs leading-5 text-text-secondary">
          {t(`boardui.permissionEffectiveReason.${effective.reason}`, { mode: t(`boardui.permission.${effective.mode}`) })}
        </p>
      ) : null}
      <PermissionModeList
        value={current}
        context={context}
        disabled={setMode.isPending}
        onSelect={(mode) => { if (mode !== current) setMode.mutate(mode); }}
        ariaLabel={t("boardui.permissions")}
      />
      <BotToolPolicies bot={bot} />
      {hasProPermissions ? (
        <details className="group rounded-xl border border-border" data-review-advanced="">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium text-text-primary">
            {t("botManage.reviewAdvanced.title")}
          </summary>
          <div className="space-y-3 px-3 pb-3">
            <p className="text-xs leading-5 text-text-tertiary">{t("botManage.reviewAdvanced.intro")}</p>
            <BotPermissionRules bot={bot} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function coordinationDraft(bot: BotDto): Pick<AutonomyPolicy, "enabled" | "timeoutSeconds"> {
  const policy = normalizeAutonomyPolicy(bot.autonomy);
  return { enabled: policy.enabled, timeoutSeconds: policy.timeoutSeconds };
}

/** Multi-bot coordination: its own draft and its own save. */
export function useCoordinationPage(bot: BotDto, open: boolean) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => coordinationDraft(bot));
  useEffect(() => {
    if (open) setDraft(coordinationDraft(bot));
  }, [open, bot]);
  const saved = coordinationDraft(bot);
  const dirty = saved.enabled !== draft.enabled || saved.timeoutSeconds !== draft.timeoutSeconds;
  const save = useMutation({
    mutationFn: () => api.updateBot(bot.id, { autonomy: normalizeAutonomyPolicy(draft) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      toast.success(t("botSettingsDialog.saveSuccess", { name: bot.name }));
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botSettingsDialog.saveFailed")),
  });
  return {
    body: (
      <div className="space-y-4">
        <p className="text-sm leading-5 text-text-secondary">{t("botSettingsDialog.autonomyIntro")}</p>
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="bot-manage-autonomy-enabled">{t("botSettingsDialog.autonomyEnabled")}</Label>
            <p className="text-xs leading-5 text-text-tertiary">{t("botSettingsDialog.autonomyEnabledHint")}</p>
          </div>
          <Switch
            id="bot-manage-autonomy-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft((value) => ({ ...value, enabled }))}
          />
        </div>
        <div className="max-w-sm">
          <AutonomyNumberField
            id="bot-manage-autonomy-timeout"
            label={t("botSettingsDialog.autonomyTimeout")}
            value={draft.timeoutSeconds}
            min={AUTONOMY_MINIMUMS.timeoutSeconds}
            max={AUTONOMY_CEILINGS.timeoutSeconds}
            onChange={(timeoutSeconds) => setDraft((value) => ({ ...value, timeoutSeconds }))}
          />
        </div>
      </div>
    ),
    footer: (
      <button type="button" className={BUTTON.primary} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? t("botSettingsDialog.saving") : t("botSettingsDialog.save")}
      </button>
    ),
  };
}

function AutonomyNumberField({ id, label, value, min, max, onChange }: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    const bounded = Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
    setDraft(String(bounded));
    onChange(bounded);
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        pattern="[0-9]*"
        value={draft}
        onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
        onBlur={commit}
      />
      <p className="text-xs text-text-tertiary">{t("botSettingsDialog.autonomyRange", { min, max })}</p>
    </div>
  );
}

/**
 * The activity of the thread the operator is looking at, read like the
 * conversation reads it (same cache entry): the branch shown through
 * `?task=` when the page opened from it, the bot's own thread otherwise.
 */
export function ActivityPage({ bot, threadId = null, open }: { bot: BotDto; threadId?: string | null; open: boolean }) {
  const { t } = useT();
  const shownThreadId = threadId ?? bot.threadId;
  const thread = useQuery({
    queryKey: queryKeys.thread(shownThreadId),
    queryFn: () => api.thread(shownThreadId),
    enabled: open,
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{t("threadActivity.description")}</p>
      {thread.isPending ? (
        <p className="py-8 text-center text-sm text-text-secondary">{t("common.loading")}</p>
      ) : thread.data ? (
        <ThreadActivityList runs={thread.data.runs} events={thread.data.events} approvals={thread.data.approvals} />
      ) : (
        <p className="py-8 text-center text-sm text-text-secondary">{t("threadActivity.empty")}</p>
      )}
    </div>
  );
}
