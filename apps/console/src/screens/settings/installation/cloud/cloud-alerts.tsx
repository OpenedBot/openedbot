import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBrandDiscord } from "@tabler/icons-react";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { canManageWorkspaceMembers, type AlertChannelDto } from "@openedbot/contracts-api";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import {
  BUTTON,
  FIELD,
  ListRow,
  ListRowsSkeleton,
  ListSection,
  Note,
  ToneBadge,
} from "../../../../components/settings/primitives";

/**
 * Runtime's « Alertes » tab (DEV-OPE2-7): the Discord webhooks that
 * receive a message when a workspace runtime stops answering, then
 * when it comes back. Reserved for owners and admins, like the route.
 *
 * The pasted URL never comes back: the list shows only the preview
 * (`discord.com/api/webhooks/<id>/…`) and the state of the last send.
 */
export function RuntimeAlertsSection() {
  const { t } = useT();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const role = me.data?.session.role;
  const canManage = me.data?.session.canWrite === true && role !== undefined && canManageWorkspaceMembers(role);
  if (me.isPending) {
    return (
      <ListSection title={t("runtimeAlerts.title")}>
        <ListRowsSkeleton label={t("runtimeAlerts.loading")} rows={1} />
      </ListSection>
    );
  }
  if (!canManage) return <Note tone="neutral">{t("runtimeAlerts.roleRequired")}</Note>;
  return <AlertChannels />;
}

function AlertChannels() {
  const { t } = useT();
  const channels = useQuery({ queryKey: queryKeys.alertChannels, queryFn: api.alertChannels });
  const list = channels.data?.channels ?? [];
  const limit = channels.data?.limit ?? 10;
  return (
    <div className="space-y-4">
      <ListSection
        title={t("runtimeAlerts.title")}
        description={t("runtimeAlerts.description")}
        action={channels.data && list.length > 0
          ? <span className="text-xs text-muted-foreground">{t("runtimeAlerts.limit", { count: String(list.length), limit: String(limit) })}</span>
          : undefined}
      >
        {channels.isPending ? <ListRowsSkeleton label={t("runtimeAlerts.loading")} rows={1} /> : null}
        {channels.error ? (
          <li className="px-4 py-3"><Note tone="danger" role="alert">{errorMessage(channels.error, t("runtimeAlerts.loadFailed"))}</Note></li>
        ) : null}
        {channels.data && list.length === 0 ? (
          <li className="px-4 py-4 text-sm text-muted-foreground">{t("runtimeAlerts.empty")}</li>
        ) : null}
        {list.map((channel) => <AlertChannelRow key={channel.id} channel={channel} />)}
      </ListSection>
      {channels.data && list.length < limit ? <AddDiscordWebhook /> : null}
    </div>
  );
}

function AlertChannelRow({ channel }: { channel: AlertChannelDto }) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.alertChannels });

  const test = useMutation({
    mutationFn: () => api.testAlertChannel(channel.id),
    onSuccess: () => toast.success(t("runtimeAlerts.tested", { name: channel.label })),
    onError: (error) => toast.error(errorMessage(error, t("runtimeAlerts.testFailed"))),
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: () => api.updateAlertChannel(channel.id, { enabled: !channel.enabled }),
    onError: (error) => toast.error(errorMessage(error, t("runtimeAlerts.toggleFailed"))),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAlertChannel(channel.id),
    onSuccess: () => toast.success(t("runtimeAlerts.removed", { name: channel.label })),
    onError: (error) => toast.error(errorMessage(error, t("runtimeAlerts.removeFailed"))),
    onSettled: async () => {
      setConfirming(false);
      await refresh();
    },
  });
  const busy = test.isPending || toggle.isPending || remove.isPending;

  const failing = channel.lastFailureReason !== null;
  const state = !channel.enabled
    ? { tone: "neutral" as const, label: t("runtimeAlerts.stateDisabled") }
    : failing
      ? { tone: "warning" as const, label: t("runtimeAlerts.stateFailing") }
      : { tone: "success" as const, label: t("runtimeAlerts.stateActive") };
  const detail = channel.lastFailureReason && channel.lastFailureAt
    ? t(`runtimeAlerts.failure.${channel.lastFailureReason}`, { date: formatDate(channel.lastFailureAt) })
    : channel.lastDeliveredAt
      ? t("runtimeAlerts.lastDelivered", { date: formatDate(channel.lastDeliveredAt) })
      : t("runtimeAlerts.neverDelivered");

  return (
    <ListRow
      icon={<IconBrandDiscord aria-hidden />}
      label={(
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate">{channel.label}</span>
          <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
        </span>
      )}
      description={(
        <>
          <span className="block font-mono text-[12px]">{channel.targetHint}</span>
          <span className={cn("block", failing && channel.enabled && "text-warn-700")}>{detail}</span>
        </>
      )}
    >
      {confirming ? (
        <>
          <button type="button" className={BUTTON.small} disabled={remove.isPending} onClick={() => setConfirming(false)}>
            {t("runtimeAlerts.cancel")}
          </button>
          <button type="button" className={BUTTON.danger} disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t("runtimeAlerts.removeConfirm")}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={BUTTON.small}
            disabled={busy || !channel.enabled}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t("runtimeAlerts.testing") : t("runtimeAlerts.test")}
          </button>
          <button type="button" className={BUTTON.small} disabled={busy} onClick={() => toggle.mutate()}>
            {channel.enabled ? t("runtimeAlerts.disable") : t("runtimeAlerts.enable")}
          </button>
          <button
            type="button"
            className={BUTTON.small}
            disabled={busy}
            aria-label={t("runtimeAlerts.removeAria", { name: channel.label })}
            onClick={() => setConfirming(true)}
          >
            {t("runtimeAlerts.remove")}
          </button>
        </>
      )}
    </ListRow>
  );
}

function AddDiscordWebhook() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const urlId = useId();
  const labelId = useId();
  const helpId = useId();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const add = useMutation({
    mutationFn: () => api.createAlertChannel({
      kind: "discord",
      webhookUrl: url.trim(),
      ...(label.trim() ? { label: label.trim() } : {}),
    }),
    onSuccess: (channel) => {
      // The URL is a secret: it does not stay in the field once saved.
      setUrl("");
      setLabel("");
      toast.success(t("runtimeAlerts.added", { name: channel.label }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.alertChannels }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim() || add.isPending) return;
    add.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-border/60 bg-card p-4" aria-labelledby={`${urlId}-title`}>
      <div>
        <h3 id={`${urlId}-title`} className="text-sm font-medium">{t("runtimeAlerts.addTitle")}</h3>
        <p id={helpId} className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("runtimeAlerts.addHelp")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label htmlFor={urlId} className="grid gap-1 text-xs font-medium">
          {t("runtimeAlerts.urlLabel")}
          <input
            id={urlId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby={helpId}
            className={FIELD}
            placeholder={t("runtimeAlerts.urlPlaceholder")}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (add.isError) add.reset();
            }}
          />
        </label>
        <label htmlFor={labelId} className="grid gap-1 text-xs font-medium">
          {t("runtimeAlerts.labelLabel")}
          <input
            id={labelId}
            type="text"
            maxLength={80}
            autoComplete="off"
            className={cn(FIELD, "font-sans")}
            placeholder={t("runtimeAlerts.labelPlaceholder")}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
      </div>
      {add.isError ? (
        <Note tone="danger" role="alert">{errorMessage(add.error, t("runtimeAlerts.addFailed"))}</Note>
      ) : null}
      <div className="flex justify-end">
        <button type="submit" className={BUTTON.primary} disabled={!url.trim() || add.isPending}>
          {add.isPending ? t("runtimeAlerts.adding") : t("runtimeAlerts.add")}
        </button>
      </div>
    </form>
  );
}
