import { useState, type ReactNode } from "react";
import {
  cn,
  Dialog,
  DotMatrix,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@openedbot/browser-ui-kit";
import {
  DEFAULT_REASONING_EFFORT,
  HERMES_REASONING_EFFORT_LABELS,
  HERMES_REASONING_EFFORTS,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import type {
  BotDto,
  RuntimeModelDto,
  RuntimeModelProviderDto,
  RuntimeModelSelectionStateDto,
} from "@openedbot/contracts-api";
import { useT } from "../../../lib/i18n";
import { BUTTON, CardHeading, SettingsCard } from "../../../components/settings/primitives";
import { activeProviderIncident } from "../../../components/provider-incident-banner";
import { NONE, type AssignmentMode, type Preference } from "./models-shared";
import { ModelBadges } from "./models-catalog-parts";
import { defaultTierModel } from "@openedbot/runtimes/domain/runtime/default-model";
import { ModelPreferenceCombobox, ProviderPreferenceCombobox } from "./models-provider-combobox";
import { GlobalOverridesNote, PerBotModelsTable, ProfileModelSyncProgress } from "./models-per-bot";

/**
 * Le brouillon d'un fournisseur : sa gamme courante (Sonnet, Luna, Flash),
 * sinon son modèle marqué `isRuntimeDefault`, sinon le premier, avec l'effort
 * par défaut si ce modèle raisonne. Rien n'est envoyé.
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
 * Où en est la vérification en arrière-plan du modèle demandé. Le modèle en
 * service reste affiché au-dessus : cette ligne ne dit que ce qui se prépare,
 * ou pourquoi cela n'a pas été appliqué.
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
  /** Un fournisseur non connecté choisi dans la liste : sa connexion s'ouvre. */
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
  effective: { provider: string | null; model: string | null; effort: HermesReasoningEffort | null };
  effectiveModel: RuntimeModelDto | null;
  effectiveIncident: ReturnType<typeof activeProviderIncident>;
};

/**
 * Bloc 1 du bureau : le modèle envoyé par défaut avec chaque run. Fournisseur,
 * modèle et effort sur une ligne ; « Laisser Hermes décider » reste le premier
 * choix du fournisseur. Rien ne part avant « Enregistrer », qui n'apparaît
 * qu'une fois le brouillon modifié. Dessous, en petit, d'où vient le modèle en
 * service (choisi ici, ou par Hermes, alors nommé), puis la vérification en
 * arrière-plan d'un nouveau choix ou la raison de son échec.
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
  effective,
  effectiveModel,
  effectiveIncident,
}: DefaultModelCardProps) {
  const { t } = useT();
  return (
    <SettingsCard className="space-y-4" data-models-default="">
      <CardHeading title={t("modelsSettings.defaultModelTitle")} description={t("modelsSettings.defaultModelDescription")} />

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(8rem,11rem)]">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="runtime-model-provider">{t("modelsSettings.mobileProviderLabel")}</Label>
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

        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="runtime-model-model">{t("modelsSettings.mobileModelLabel")}</Label>
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

        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="runtime-model-effort">{t("modelsSettings.mobileEffortLabel")}</Label>
          <Select
            value={preference.effort ?? NONE}
            disabled={saving || !activeModel?.reasoning}
            onValueChange={(value) => edit({ ...preference, effort: value === NONE ? null : value as HermesReasoningEffort })}
          >
            <SelectTrigger id="runtime-model-effort"><SelectValue /></SelectTrigger>
            <SelectContent side="bottom" avoidCollisions={false} rows={6}><SelectGroup>
              <SelectItem value={NONE}>{t("modelsSettings.noEffort")}</SelectItem>
              {HERMES_REASONING_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{HERMES_REASONING_EFFORT_LABELS[effort]}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* D'où vient le modèle EN SERVICE, ni le brouillon ni la vérification
            en cours. Quand Hermes décide, les sélecteurs n'en disent rien :
            la ligne nomme alors le modèle qu'il applique. */}
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
          data-model-source={hermesDecides ? "hermes" : "here"}
        >
          {saving ? (
            <DotMatrix state="syncing" label={t("modelsSettings.saving")} className="size-3.5" />
          ) : null}
          <span>{hermesDecides ? t("modelsSettings.sourceChosenByHermes") : t("modelsSettings.sourceChosenHere")}</span>
          {hermesDecides ? (
            <>
              <span aria-hidden>·</span>
              {hermesDefaultPending ? (
                <span>{t("modelsSettings.defaultPending")}</span>
              ) : (
                <span className="font-mono">
                  <span className="text-foreground">{effective.model ?? "-"}</span>
                  {" "}
                  {effective.provider ?? "-"}
                </span>
              )}
            </>
          ) : null}
          {effectiveModel ? <ModelBadges model={effectiveModel} /> : null}
          {incidentBadge}
        </div>
        {dirty ? (
          <div className="flex shrink-0 items-center gap-2" data-model-selection-actions="">
            <button type="button" className={BUTTON.secondary} disabled={saving} onClick={onReset}>
              {t("modelsSettings.selectionReset")}
            </button>
            <button type="button" className={BUTTON.primary} disabled={saving} onClick={onSave}>
              {t("modelsSettings.selectionSave")}
            </button>
          </div>
        ) : null}
      </div>

      {effectiveIncident ? (
        <p className="text-sm text-destructive-text" role="status">
          {t("providerIncidents.runsWillFail", { provider: effectiveIncident.provider })}
        </p>
      ) : null}
      {modelSelection ? (
        <div className="border-t border-border pt-3">
          <ModelSelectionProgress
            selection={modelSelection}
            busy={selectionBusy}
            onCancel={onCancelSelection}
            onRetry={onRetrySelection}
          />
        </div>
      ) : null}
    </SettingsCard>
  );
}

/**
 * Bloc 2 du bureau : comment les bots prennent leur modèle. Deux boutons radio
 * à la place des anciens onglets « Global / Par bot », parce que c'est un
 * réglage de l'organisation (`organizations.model_assignment_mode`), pas une
 * vue : un clic l'enregistre. Passer au modèle commun alors que des bots ont
 * le leur demande confirmation : ils seront ignorés, pas effacés. Le tableau
 * des bots reste visible dans les deux modes, grisé en mode commun.
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
  const options: { value: AssignmentMode; label: string; hint: string }[] = [
    { value: "global", label: t("modelsSettings.modeAllLabel"), hint: t("modelsSettings.modeAllHint") },
    { value: "perBot", label: t("modelsSettings.modeEachLabel"), hint: t("modelsSettings.modeEachHint") },
  ];
  return (
    <SettingsCard className="space-y-4" data-models-bots="">
      <CardHeading title={t("modelsSettings.botModelsTitle")} />
      <RadioGroup
        value={mode}
        onValueChange={(value) => pick(value as AssignmentMode)}
        disabled={modePending}
        aria-label={t("modelsSettings.botModelsTitle")}
        className="grid gap-2 sm:grid-cols-2"
      >
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
              mode === option.value ? "border-primary/60 bg-primary/5" : "border-border hover:bg-surface-hover",
            )}
          >
            <RadioGroupItem value={option.value} className="mt-0.5" data-model-assignment={option.value} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs leading-5 text-muted-foreground">{option.hint}</span>
            </span>
          </label>
        ))}
      </RadioGroup>

      {mode === "global" && overriddenBots.length > 0 ? <GlobalOverridesNote bots={overriddenBots} /> : null}
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
    </SettingsCard>
  );
}
