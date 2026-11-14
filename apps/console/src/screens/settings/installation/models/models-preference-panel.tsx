import { useId, useState, type ReactNode } from "react";
import {
  Dialog,
  DotMatrix,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@openedbot/browser-ui-kit";
import {
  DEFAULT_REASONING_EFFORT,
  HERMES_REASONING_EFFORTS,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import type {
  BotDto,
  RuntimeModelDto,
  RuntimeModelProviderDto,
  RuntimeModelSelectionStateDto,
} from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import {
  ACTIONS,
  BUTTON,
  CARD_DESCRIPTION,
  CARD_TITLE,
  ListRow,
  ListSection,
  SETTINGS_INSET,
  SETTINGS_SHELL,
  SETTINGS_SHELL_HEADER,
} from "../../../../components/settings/primitives";
import { SegmentedRadio } from "../../../../components/settings/segmented";
import { activeProviderIncident } from "../../../../components/provider-incident-banner";
import { NONE, type AssignmentMode, type Preference } from "./models-shared";
import { ModelBadges } from "./models-catalog-parts";
import { defaultTierModel } from "@openedbot/runtimes/domain/runtime/default-model";
import { ModelPreferenceCombobox, ProviderPreferenceCombobox } from "./models-provider-combobox";
import { GlobalOverridesNote, PerBotModelsTable, ProfileModelSyncProgress } from "./models-per-bot";
import { effortLabel } from "@/lib/bots/effort-label";

/**
 * A provider's draft: its current range (Sonnet, Luna, Flash),
 * otherwise its model marked `isRuntimeDefault`, otherwise the first, with the default
 * effort if that model reasons. Nothing is sent.
 */
export function preferenceForProvider(
  provider: RuntimeModelProviderDto | null,
  slug: string | null,
): Preference {
  const model = (provider && defaultTierModel(provider.models))
    ?? provider?.models.find((entry) => entry.isRuntimeDefault)
    ?? provider?.models[0]
    ?? null;
  return {
    provider: slug,
    model: model?.id ?? null,
    effort: model?.reasoning ? DEFAULT_REASONING_EFFORT : null,
  };
}

/**
 * Where the background check of the requested model stands. The model in
 * service stays displayed above: this line says only what is being prepared,
 * or why it was not applied.
 */
export function ModelSelectionProgress({
  selection,
  busy,
  onCancel,
  onRetry,
}: {
  selection: RuntimeModelSelectionStateDto;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useT();
  const target = selection.model ?? t("modelsSettings.defaultBadge");
  if (selection.status === "failed") {
    return (
      <div className="space-y-2" data-model-selection="failed">
        <p className="text-sm text-destructive-text" role="alert">
          {t("modelsSettings.selectionFailed", {
            model: target,
            message: selection.error?.message ?? t("modelsSettings.saveFailed"),
          })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON.small} disabled={busy} onClick={onRetry}>
            {t("modelsSettings.selectionRetry")}
          </button>
          <button type="button" className={BUTTON.small} disabled={busy} onClick={onCancel}>
            {t("modelsSettings.selectionDismiss")}
          </button>
        </div>
      </div>
    );
  }
  const label = selection.provider !== null && selection.model !== null
    ? t("modelsSettings.selectionVerifying", { model: selection.model, provider: selection.provider })
    : t("modelsSettings.selectionVerifyingHermes");
  const step = selection.status === "running"
    ? t("modelsSettings.selectionRunning")
    : t(selection.attempts > 0 ? "modelsSettings.selectionBusy" : "modelsSettings.selectionQueued");
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2" data-model-selection={selection.status}>
      <div className="flex min-w-0 items-center gap-2" role="status">
        <DotMatrix state="syncing" label={label} className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 text-sm text-muted-foreground">
          <span className="font-mono">{label}</span>
          <span className="block text-xs">{step}</span>
        </p>
      </div>
      <button type="button" className={BUTTON.small} disabled={busy} onClick={onCancel}>
        {t("modelsSettings.selectionCancel")}
      </button>
    </div>
  );
}


export type DefaultModelCardProps = {
  providers: RuntimeModelProviderDto[];
  preference: Preference;
  saving: boolean;
  edit: (next: Preference) => void;
  dirty: boolean;
  onSave: () => void;
  onReset: () => void;
  /** A disconnected provider chosen in the list: its connection opens. */
  onConnectProvider: (slug: string) => void;
  activeProvider: RuntimeModelProviderDto | null;
  activeModel: RuntimeModelDto | null;
  modelSelection: RuntimeModelSelectionStateDto | null;
  selectionBusy: boolean;
  onCancelSelection: () => void;
  onRetrySelection: () => void;
  incidentBadge: ReactNode;
  hermesDecides: boolean;
  hermesDefaultPending: boolean;
  /** Who picks the model when openedbot imposes nothing: the host's default, or openedbot when the host has none. */
  automaticChosenBy: "hermes" | "openedbot";
  effective: { provider: string | null; model: string | null; effort: HermesReasoningEffort | null };
  effectiveModel: RuntimeModelDto | null;
  effectiveIncident: ReturnType<typeof activeProviderIncident>;
};

/** A control's slot at the right of a `ListRow`: one width for the three, so they align. */
const ROW_CONTROL = "w-72 max-w-full";

/**
 * Desktop block 1: the model sent by default with each run, as a settings
 * list (`DESIGN.md` › Bureau › Regrouper et aligner). The first row is the
 * model IN SERVICE and where it comes from (chosen here, or by Hermes): the
 * one fact the runs depend on, named whatever the draft says. Then one row
 * per selector, the control on the right; « Laisser Hermes décider » stays
 * the provider's first choice. Nothing leaves before « Enregistrer », which
 * appears in the footer only once the draft is modified, with the background
 * check of a new choice or the reason for its failure.
 */
export function DefaultModelCard({
  providers,
  preference,
  saving,
  edit,
  dirty,
  onSave,
  onReset,
  onConnectProvider,
  activeProvider,
  activeModel,
  modelSelection,
  selectionBusy,
  onCancelSelection,
  onRetrySelection,
  incidentBadge,
  hermesDecides,
  hermesDefaultPending,
  automaticChosenBy,
  effective,
  effectiveModel,
  effectiveIncident,
}: DefaultModelCardProps) {
  const { t } = useT();
  const effectiveProviderName = providers.find((provider) => provider.slug === effective.provider)?.name
    ?? effective.provider;
  const source = hermesDecides
    ? t(automaticChosenBy === "openedbot" ? "modelsSettings.sourceChosenAutomatically" : "modelsSettings.sourceChosenByHermes")
    : t("modelsSettings.sourceChosenHere");
  const footer = dirty || effectiveIncident || modelSelection ? (
    <>
      {effectiveIncident ? (
        <p className="text-sm text-destructive-text" role="status">
          {t("providerIncidents.runsWillFail", { provider: effectiveIncident.provider })}
        </p>
      ) : null}
      {modelSelection ? (
        <ModelSelectionProgress
          selection={modelSelection}
          busy={selectionBusy}
          onCancel={onCancelSelection}
          onRetry={onRetrySelection}
        />
      ) : null}
      {dirty ? (
        <div className={ACTIONS} data-model-selection-actions="">
          <button type="button" className={BUTTON.secondary} disabled={saving} onClick={onReset}>
            {t("modelsSettings.selectionReset")}
          </button>
          <button type="button" className={BUTTON.primary} disabled={saving} onClick={onSave}>
            {t("modelsSettings.selectionSave")}
          </button>
        </div>
      ) : null}
    </>
  ) : undefined;

  return (
    <div data-models-default="">
      <ListSection
        title={t("modelsSettings.defaultModelTitle")}
        description={t("modelsSettings.defaultModelDescription")}
        footer={footer}
      >
        {/* The model IN SERVICE, neither the draft nor the check in
            progress. When Hermes decides, the selectors say nothing about
            it: this row names the model it applies. */}
        <ListRow
          label={t("modelsSettings.inServiceLabel")}
          description={(
            <span className="inline-flex items-center gap-1.5" data-model-source={hermesDecides ? "hermes" : "here"}>
              {saving ? <DotMatrix state="syncing" label={t("modelsSettings.saving")} className="size-3.5" /> : null}
              {source}
            </span>
          )}
        >
          {hermesDefaultPending ? (
            <span className="text-sm text-muted-foreground">{t("modelsSettings.defaultPending")}</span>
          ) : (
            <span className="flex min-w-0 items-baseline gap-2" data-model-in-service="">
              <span className="truncate text-sm font-medium text-foreground">{effective.model ?? "-"}</span>
              {effectiveProviderName ? (
                <span className="shrink-0 text-sm text-muted-foreground">{effectiveProviderName}</span>
              ) : null}
            </span>
          )}
          {effectiveModel ? <ModelBadges model={effectiveModel} /> : null}
          {incidentBadge}
        </ListRow>

        <ListRow label={<Label htmlFor="runtime-model-provider">{t("modelsSettings.mobileProviderLabel")}</Label>}>
          <div className={ROW_CONTROL}>
            <ProviderPreferenceCombobox
              providers={providers}
              value={preference.provider}
              disabled={saving}
              onConnectProvider={onConnectProvider}
              onValueChange={(value) => {
                const provider = providers.find((entry) => entry.slug === value) ?? null;
                edit(preferenceForProvider(provider, value === NONE ? null : value));
              }}
            />
          </div>
        </ListRow>

        <ListRow label={<Label htmlFor="runtime-model-model">{t("modelsSettings.mobileModelLabel")}</Label>}>
          <div className={ROW_CONTROL}>
            <ModelPreferenceCombobox
              models={activeProvider?.models ?? []}
              value={preference.model}
              disabled={saving || !activeProvider?.authenticated || activeProvider.models.length === 0}
              onValueChange={(value) => {
                const model = activeProvider?.models.find((entry) => entry.id === value) ?? null;
                edit({ ...preference, model: value, effort: model?.reasoning ? preference.effort ?? DEFAULT_REASONING_EFFORT : null });
              }}
            />
          </div>
        </ListRow>

        <ListRow
          label={<Label htmlFor="runtime-model-effort">{t("modelsSettings.perBotColumnEffort")}</Label>}
          description={t("modelsSettings.effortHint")}
        >
          <div className={ROW_CONTROL}>
            <Select
              value={preference.effort ?? NONE}
              disabled={saving || !activeModel?.reasoning}
              onValueChange={(value) => edit({ ...preference, effort: value === NONE ? null : value as HermesReasoningEffort })}
            >
              <SelectTrigger
                id="runtime-model-effort"
                // `line-clamp-1` does not hold under `display: flex`: « Aucun effort explicite » ran onto two lines.
                className="w-full *:data-[slot=select-value]:block! *:data-[slot=select-value]:truncate"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="bottom" avoidCollisions={false} rows={6}><SelectGroup>
                <SelectItem value={NONE}>{t("modelsSettings.noEffort")}</SelectItem>
                {HERMES_REASONING_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effortLabel(t, effort)}</SelectItem>)}
              </SelectGroup></SelectContent>
            </Select>
          </div>
        </ListRow>
      </ListSection>
    </div>
  );
}

/**
 * Desktop block 2: how bots take their model. A segmented control in the
 * card's header (`DESIGN.md` › Bureau › Regrouper et aligner), because it is
 * an organization setting (`organizations.model_assignment_mode`), not a
 * view: a click saves it. The sentence under the title explains the mode in
 * force. Switching to the shared model while bots have their own asks for
 * confirmation: they will be ignored, not erased. The bot table sits flat in
 * the card, visible in both modes, greyed out in shared mode.
 */
export function BotModelsCard({
  mode,
  modePending,
  chooseMode,
  overriddenBots,
  activeBots,
  rosterPending,
  rosterError,
  providers,
  globalModel,
  globalProvider,
}: {
  mode: AssignmentMode;
  modePending: boolean;
  chooseMode: (next: AssignmentMode) => void;
  overriddenBots: BotDto[];
  activeBots: BotDto[];
  rosterPending: boolean;
  rosterError: boolean;
  providers: RuntimeModelProviderDto[];
  globalModel: string | null;
  globalProvider: string | null;
}) {
  const { t } = useT();
  const [confirmingGlobal, setConfirmingGlobal] = useState(false);
  const pick = (next: AssignmentMode) => {
    if (next === mode) return;
    if (next === "global" && overriddenBots.length > 0) {
      setConfirmingGlobal(true);
      return;
    }
    chooseMode(next);
  };
  const options: { value: AssignmentMode; label: string }[] = [
    { value: "global", label: t("modelsSettings.modeAllLabel") },
    { value: "perBot", label: t("modelsSettings.modeEachLabel") },
  ];
  const overridesNote = mode === "global" && overriddenBots.length > 0;
  const titleId = useId();
  return (
    <section data-settings-card="" data-models-bots="" className={SETTINGS_SHELL}>
      <div className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-3 ${SETTINGS_SHELL_HEADER}`}>
        <div className="min-w-0 flex-1 basis-56">
          <h2 id={titleId} className={CARD_TITLE}>{t("modelsSettings.botModelsTitle")}</h2>
          <p className={CARD_DESCRIPTION}>
            {t(mode === "global" ? "modelsSettings.modeAllHint" : "modelsSettings.modeEachHint")}
          </p>
        </div>
        {/* Named by the card's title rather than a hidden `<legend>` repeating it. */}
        <fieldset disabled={modePending} aria-labelledby={titleId} className="shrink-0" data-model-assignment-mode={mode}>
          <SegmentedRadio
            name="model-assignment-mode"
            options={options}
            value={mode}
            onChange={pick}
          />
        </fieldset>
      </div>

      {/* The card set in the tray: its blocks are separated by hairlines. */}
      <div className={`${SETTINGS_INSET} divide-y divide-border/60`}>
        {overridesNote ? (
          <div className="px-4 py-3">
            <GlobalOverridesNote bots={overriddenBots} />
          </div>
        ) : null}
        <ProfileModelSyncProgress />

        <PerBotModelsTable
          bots={activeBots}
          rosterPending={rosterPending}
          rosterError={rosterError}
          providers={providers}
          globalModel={globalModel}
          globalProvider={globalProvider}
          inactive={mode === "global"}
        />
      </div>

      {confirmingGlobal ? (
        <Dialog
          open
          onClose={() => setConfirmingGlobal(false)}
          role="alertdialog"
          title={t("modelsSettings.modeAllConfirmTitle")}
          description={t("modelsSettings.modeAllConfirmDescription", { count: overriddenBots.length })}
          closeLabel={t("modelsSettings.close")}
          className="max-w-md"
          swipeToDismiss={false}
          footer={
            <div className="flex justify-end gap-2">
              <button type="button" className={BUTTON.secondary} onClick={() => setConfirmingGlobal(false)}>
                {t("modelsSettings.selectionReset")}
              </button>
              <button
                type="button"
                className={BUTTON.primary}
                onClick={() => {
                  setConfirmingGlobal(false);
                  chooseMode("global");
                }}
              >
                {t("modelsSettings.modeAllConfirm")}
              </button>
            </div>
          }
        />
      ) : null}
    </section>
  );
}
