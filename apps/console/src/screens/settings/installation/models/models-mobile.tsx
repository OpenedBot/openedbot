import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconChevronRight, IconSearch } from "@tabler/icons-react";
import { cn, Dialog, Input, toast } from "@openedbot/browser-ui-kit";
import {
  DEFAULT_REASONING_EFFORT,
  HERMES_REASONING_EFFORT_LABELS,
  HERMES_REASONING_EFFORTS,
  isHermesReasoningEffort,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import type {
  BotDto,
  RuntimeModelCatalogDto,
  RuntimeModelProviderDto,
  RuntimeModelSelectionStateDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { catalogModelView, modelsByRelease } from "@/lib/bots/model-catalog";
import { BotFace } from "../../../../components/bot-face";
import { BUTTON, Note, SectionHeading, ToneBadge } from "../../../../components/settings/primitives";
import {
  InsetGroupedRow,
  InsetGroupedSection,
  InsetGroupedStatic,
  insetGroupedRowClassName,
} from "../../../../components/mobile/inset-grouped";
import {
  MobileChoiceSheet,
  type ChoiceGroup,
  type ChoiceOption,
} from "../../../../components/mobile/choice-sheet";
import { SettingsPane } from "../../pane";
import {
  activeProviderIncident,
  ProviderIncidentDialog,
} from "../../../../components/provider-incident-banner";
import { runtimeHealthLabel } from "../../../../lib/runtime/runtime-health";
import { NONE, type Preference, type RuntimeOffline } from "./models-shared";
import { RuntimeOfflineVeil } from "./models-offline";
import { ProviderConfigDialog } from "./models-provider-dialog";
import { ModelSelectionProgress, preferenceForProvider } from "./models-preference-panel";

/* ─── Téléphone : l'écran Modèles en app ─────────────────────────────── */

/**
 * Modèles, sur téléphone : une liste de réglages, pas un tableau de bord.
 *
 * Ce que l'écran montrait tenait de la console : deux onglets pour deux vues
 * du même réglage, trois `<select>` empilés dans une carte, un annuaire de
 * fournisseurs à défilement PROPRE au milieu d'une page qui défilait déjà, et
 * trois tuiles de chiffres (bots, exécutions, décisions) qui appartiennent à
 * la Vue d'ensemble et n'ont rien à voir avec le choix d'un modèle.
 *
 * Ici : quatre groupes, chaque réglage sur une ligne qui montre sa valeur, et
 * chaque choix dans une feuille à coches. Les onglets « Global / Par bot »
 * disparaissent : ce n'étaient pas deux vues, c'étaient deux GROUPES, et la
 * règle de précédence (le bot prime) se dit une fois en pied de groupe au lieu
 * d'être devinée d'un commutateur.
 */
export function ModelsMobile({
  runtime,
  runtimeId,
  reachability,
  providers,
  catalog,
  catalogFetching,
  onRefresh,
  preference,
  effective,
  hermesDecides,
  hermesDefaultPending,
  saving,
  onEdit,
  dirty,
  onSave,
  onReset,
  modelSelection,
  selectionBusy,
  onCancelSelection,
  onRetrySelection,
  bots,
  overriddenBots,
  rosterPending,
  rosterError,
  readinessNoProvider,
  onProviderConnected,
  offline,
  incidentDialog = true,
}: {
  runtime: RuntimePublicDto | null;
  runtimeId: string | null;
  reachability: RuntimePublicDto["reachability"] | null;
  providers: RuntimeModelProviderDto[];
  catalog: RuntimeModelCatalogDto | null;
  catalogFetching: boolean;
  onRefresh: () => void;
  preference: Preference;
  effective: { provider: string | null; model: string | null; effort: HermesReasoningEffort | null } | null;
  hermesDecides: boolean;
  hermesDefaultPending: boolean;
  saving: boolean;
  onEdit: (next: Preference) => void;
  dirty: boolean;
  onSave: () => void;
  onReset: () => void;
  modelSelection: RuntimeModelSelectionStateDto | null;
  selectionBusy: boolean;
  onCancelSelection: () => void;
  onRetrySelection: () => void;
  bots: BotDto[];
  overriddenBots: BotDto[];
  rosterPending: boolean;
  rosterError: boolean;
  readinessNoProvider: boolean;
  onProviderConnected: (slug: string) => void;
  offline: RuntimeOffline | null;
  /** `false` while the screen was opened on one provider's reconnection: that dialog already says it. */
  incidentDialog?: boolean;
}) {
  const { t, locale, formatNumber } = useT();
  const [picker, setPicker] = useState<"provider" | "model" | "effort" | null>(null);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [bot, setBot] = useState<BotDto | null>(null);

  const activeProvider = providers.find((entry) => entry.slug === preference.provider) ?? null;
  const mobileIncident = activeProviderIncident(runtime?.providerIncidents, effective?.provider);
  const activeModel = activeProvider?.models.find((model) => model.id === preference.model) ?? null;
  const connected = providers.filter((provider) => provider.authenticated && provider.sdkInstalled !== false);

  /*
    La ligne d'un réglage montre ce qui SERA envoyé, pas ce qui est stocké.
    Quand openedbot n'impose rien, la valeur est celle que Hermes applique, dite
    comme telle en pied de groupe, sans quoi « - » se lit comme une panne.
  */
  const draftHermesDecides = preference.provider === null;
  const providerValue = draftHermesDecides
    ? (catalog?.currentProvider ?? t("modelsSettings.sourceHermes"))
    : (activeProvider?.name ?? preference.provider ?? "-");
  const modelValue = draftHermesDecides
    ? (catalog?.runtimeDefaultModel ?? t("modelsSettings.mobileModelPending"))
    : (preference.model ?? t("modelsSettings.noModel"));
  const effortValue = preference.effort
    ? HERMES_REASONING_EFFORT_LABELS[preference.effort]
    : t("modelsSettings.mobileEffortNone");

  const providerGroups: ChoiceGroup<string>[] = [
    {
      options: [
        {
          id: NONE,
          label: t("modelsSettings.noPreference"),
          detail: catalog?.currentProvider
            ? t("modelsSettings.currentProvider") + " · " + catalog.currentProvider
            : undefined,
        },
      ],
    },
    {
      caption: t("modelsSettings.providerGroupConnected"),
      // Pas « l'annuaire ci-dessous » : dans une feuille il n'y a pas de
      // « dessous », il y a le bouton de la barre du bas.
      footer: t("modelsSettings.mobileProviderLockedHint"),
      options: connected.map((provider) => ({
        id: provider.slug,
        label: provider.name,
        detail: t("modelsSettings.modelCount", { count: formatNumber(provider.models.length) }),
        trailing: provider.isCurrent ? <ToneBadge tone="success">{t("modelsSettings.active")}</ToneBadge> : undefined,
      })),
    },
  ];

  const modelOptions: ChoiceOption<string>[] = modelsByRelease(activeProvider?.models ?? [], [preference.model]).map((model) => ({
    id: model.id,
    label: model.id,
    detail: model.reasoning ? t("modelsSettings.reasoning") : t("modelsSettings.fast"),
  }));

  const effortOptions: ChoiceOption<string>[] = [
    { id: NONE, label: t("modelsSettings.noEffort") },
    ...HERMES_REASONING_EFFORTS.map((effort) => ({
      id: effort as string,
      label: HERMES_REASONING_EFFORT_LABELS[effort],
    })),
  ];

  return (
    <SettingsPane
      footer={
        dirty ? (
          <>
            <button type="button" className={BUTTON.secondary} disabled={saving} onClick={onReset}>
              {t("modelsSettings.selectionReset")}
            </button>
            <button type="button" className={BUTTON.primary} disabled={saving} onClick={onSave}>
              {t("modelsSettings.selectionSave")}
            </button>
          </>
        ) : (
          <button type="button" className={BUTTON.secondary} disabled={catalogFetching} onClick={onRefresh}>
            {catalogFetching ? t("modelsSettings.refreshing") : t("modelsSettings.refresh")}
          </button>
        )
      }
    >
      <SectionHeading title={t("modelsSettings.title")} description={t("modelsSettings.description")} />
      {incidentDialog ? (
        <ProviderIncidentDialog
          incidents={runtime?.providerIncidents}
          onReconnect={() => setProvidersOpen(true)}
        />
      ) : null}

      {readinessNoProvider ? (
        <Note tone="warning" role="alert">
          <strong>{t("modelsSettings.noProviderTitle")}</strong>: {t("modelsSettings.noProviderDescription")}
        </Note>
      ) : null}

      <RuntimeOfflineVeil
        offline={offline}
        runtime={runtime}
        onRetry={onRefresh}
        className="flex flex-col gap-2"
      >
      <InsetGroupedSection
        caption={t("modelsSettings.mobileDefaultCaption")}
        footer={
          mobileIncident
            ? t("providerIncidents.runsWillFail", { provider: mobileIncident.provider })
            : hermesDefaultPending
            ? t("modelsSettings.defaultPending")
            : hermesDecides
              ? t("modelsSettings.preferenceHermesHint")
              : t("modelsSettings.mobileDefaultFooter")
        }
      >
        {/* Libellés COURTS : une ligne iOS n'a que ~45 % de sa largeur pour
            le libellé, et « Fournisseur demandé » s'y tronquait à
            « Fournisseur dema… ». Le titre du groupe porte déjà le contexte. */}
        <InsetGroupedRow
          label={t("modelsSettings.mobileProviderLabel")}
          value={providerValue}
          disabled={saving}
          onClick={() => setPicker("provider")}
        />
        <InsetGroupedRow
          label={t("modelsSettings.mobileModelLabel")}
          value={modelValue}
          /* Sans fournisseur choisi, il n'y a pas de liste à ouvrir : la ligne
             montre ce que Hermes applique et refuse le doigt plutôt que
             d'ouvrir une feuille vide. */
          disabled={saving || draftHermesDecides || !activeProvider?.authenticated || activeProvider.sdkInstalled === false}
          onClick={() => setPicker("model")}
        />
        <InsetGroupedRow
          label={t("modelsSettings.mobileEffortLabel")}
          value={effortValue}
          disabled={saving || !activeModel?.reasoning}
          onClick={() => setPicker("effort")}
        />
      </InsetGroupedSection>

      {modelSelection ? (
        <div className="mx-4 rounded-[20px] bg-[var(--openedbot-grouped-card)] px-4 py-3">
          <ModelSelectionProgress
            selection={modelSelection}
            busy={selectionBusy}
            onCancel={onCancelSelection}
            onRetry={onRetrySelection}
          />
        </div>
      ) : null}

      {rosterError ? (
        <Note tone="danger" role="alert">{t("modelsSettings.perBotRosterFailed")}</Note>
      ) : rosterPending ? null : bots.length === 0 ? (
        <p className="px-8 pt-4 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
          {t("modelsSettings.perBotEmpty")}
        </p>
      ) : (
        <InsetGroupedSection
          caption={t("modelsSettings.modePerBot")}
          footer={
            overriddenBots.length === 0
              ? t("modelsSettings.mobilePerBotAllGlobal")
              : t("modelsSettings.mobilePerBotFooter", {
                  count: formatNumber(overriddenBots.length),
                  total: formatNumber(bots.length),
                })
          }
        >
          {bots.map((entry) => (
            <BotModelRow key={entry.id} bot={entry} onOpen={() => setBot(entry)} />
          ))}
        </InsetGroupedSection>
      )}

      <InsetGroupedSection
        caption={t("modelsSettings.providerAccess")}
        footer={t("modelsSettings.providerAccessHint")}
      >
        <InsetGroupedRow
          label={t("modelsSettings.mobileProviderRow")}
          value={t("modelsSettings.providerConnectedCount", { count: formatNumber(connected.length) })}
          aria-label={t("modelsSettings.openProvidersAria")}
          onClick={() => setProvidersOpen(true)}
        />
      </InsetGroupedSection>
      </RuntimeOfflineVeil>

      {runtime ? (
        <InsetGroupedSection caption={t("modelsSettings.mobileRuntimeCaption")}>
          <InsetGroupedStatic
            label={t("modelsSettings.runtimeState")}
            value={runtimeHealthLabel(runtime, null, locale)}
          />
          <InsetGroupedStatic
            label={t("modelsSettings.mobileRuntimeModeLabel")}
            value={reachability === "direct" ? t("runtimeDirect.direct") : t("modelsSettings.reachabilityLink")}
          />
        </InsetGroupedSection>
      ) : null}

      <MobileChoiceSheet
        open={picker === "provider"}
        title={t("modelsSettings.mobileProviderPickerTitle")}
        description={t("modelsSettings.catalogReadOnly")}
        closeLabel={t("modelsSettings.close")}
        groups={providerGroups}
        value={preference.provider ?? NONE}
        onClose={() => setPicker(null)}
        onSelect={(slug) => {
          const provider = providers.find((entry) => entry.slug === slug) ?? null;
          onEdit(preferenceForProvider(provider, slug === NONE ? null : slug));
        }}
        footer={
          <button
            type="button"
            className={BUTTON.secondary}
            onClick={() => {
              setPicker(null);
              setProvidersOpen(true);
            }}
          >
            {t("modelsSettings.mobileManageProviders")}
          </button>
        }
      />

      <MobileChoiceSheet
        open={picker === "model"}
        title={t("modelsSettings.mobileModelPickerTitle")}
        description={activeProvider?.name}
        closeLabel={t("modelsSettings.close")}
        groups={[{ options: modelOptions }]}
        value={preference.model}
        onClose={() => setPicker(null)}
        onSelect={(id) => {
          const model = activeProvider?.models.find((entry) => entry.id === id) ?? null;
          onEdit({
            ...preference,
            model: id,
            effort: model?.reasoning ? (preference.effort ?? DEFAULT_REASONING_EFFORT) : null,
          });
        }}
      />

      <MobileChoiceSheet
        open={picker === "effort"}
        title={t("modelsSettings.mobileEffortPickerTitle")}
        closeLabel={t("modelsSettings.close")}
        groups={[{ options: effortOptions }]}
        value={preference.effort ?? NONE}
        onClose={() => setPicker(null)}
        onSelect={(id) =>
          onEdit({ ...preference, effort: id === NONE ? null : (id as HermesReasoningEffort) })
        }
      />

      <BotModelSheet
        bot={bot}
        providers={providers}
        globalModel={effective?.model ?? null}
        onClose={() => setBot(null)}
      />

      {runtime && runtimeId ? (
        <MobileProvidersSheet
          open={providersOpen}
          runtime={runtime}
          providers={providers}
          hermesProfile={catalog?.hermesProfile ?? null}
          onClose={() => setProvidersOpen(false)}
          onConnected={onProviderConnected}
        />
      ) : null}
    </SettingsPane>
  );
}

/** La ligne d'un bot : son modèle, ou le fait qu'il suit le défaut. */
function BotModelRow({ bot, onOpen }: { bot: BotDto; onOpen: () => void }) {
  const { t } = useT();
  return (
    <li>
      <button
        type="button"
        data-inset-grouped-row=""
        aria-label={t("modelsSettings.mobileBotTitle", { name: bot.name })}
        onClick={onOpen}
        className={cn(insetGroupedRowClassName, "min-h-14")}
      >
        <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-7 shrink-0" />
        <span className="min-w-0 flex-1 py-2.5">
          <span className="block truncate text-left text-[17px] leading-[22px] text-[var(--openedbot-grouped-label)]">
            {bot.name}
          </span>
          <span className="mt-0.5 block truncate text-left text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
            {bot.model ?? t("modelsSettings.mobileFollowsGlobal")}
          </span>
        </span>
        <IconChevronRight aria-hidden className="size-5 shrink-0 text-[var(--openedbot-grouped-chevron)]" />
      </button>
    </li>
  );
}

/**
 * Le modèle d'un bot, en feuille : deux lignes, deux sélecteurs.
 *
 * L'enregistrement part au choix, sans bouton « Enregistrer » : c'est un
 * réglage, pas un formulaire, et c'est déjà ce que faisait le tableau du
 * bureau.
 */
function BotModelSheet({
  bot,
  providers,
  globalModel,
  onClose,
}: {
  bot: BotDto | null;
  providers: RuntimeModelProviderDto[];
  globalModel: string | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [picker, setPicker] = useState<"model" | "effort" | null>(null);
  const { groups: modelGroups, knownIds, reasoningIds } = catalogModelView(providers, [bot?.model ?? null, globalModel]);
  // Le bot survit à la fermeture le temps que la feuille glisse dehors.
  const lastRef = useRef<BotDto | null>(null);
  if (bot !== null) lastRef.current = bot;
  const shown = bot ?? lastRef.current;

  const save = useMutation({
    mutationFn: (input: { model: string | null; effort: HermesReasoningEffort | null }) =>
      api.updateBot(shown!.id, { model: input.model, reasoningEffort: input.effort }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
    onSuccess: () => toast.success(t("modelsSettings.perBotSaved", { name: shown?.name ?? "" })),
    onError: (error: Error) => toast.error(error.message || t("modelsSettings.saveFailed")),
  });

  if (shown === null) return null;
  const unknownModel = shown.model !== null && !knownIds.has(shown.model);
  const reasoning = shown.model !== null && reasoningIds.has(shown.model);
  // `BotDto.reasoningEffort` est un `string` sur le fil : une valeur écrite
  // par une version antérieure ne serait pas forcément un effort connu.
  const botEffort = isHermesReasoningEffort(shown.reasoningEffort) ? shown.reasoningEffort : null;

  return (
    <>
      <Dialog
        open={bot !== null}
        onClose={onClose}
        title={shown.name}
        description={shown.model ?? t("modelsSettings.mobileFollowsGlobal")}
        closeLabel={t("modelsSettings.close")}
        bodyClassName="px-0 py-0"
      >
        <div className="pb-4">
          <InsetGroupedSection
            className="pt-2"
            footer={
              unknownModel
                ? t("modelsSettings.perBotUnknownHint")
                : t("modelsSettings.perBotDescription", { model: globalModel ?? "-" })
            }
          >
            <InsetGroupedRow
              label={t("modelsSettings.mobileModelLabel")}
              value={
                shown.model === null
                  ? t("modelsSettings.perBotGlobalOption")
                  : unknownModel
                    ? t("modelsSettings.perBotUnknownModel", { model: shown.model })
                    : shown.model
              }
              disabled={save.isPending}
              onClick={() => setPicker("model")}
            />
            <InsetGroupedRow
              label={t("modelsSettings.mobileEffortLabel")}
              value={
                botEffort
                  ? HERMES_REASONING_EFFORT_LABELS[botEffort]
                  : t("modelsSettings.perBotEffortDefault")
              }
              disabled={save.isPending || !reasoning}
              onClick={() => setPicker("effort")}
            />
          </InsetGroupedSection>
        </div>
      </Dialog>

      <MobileChoiceSheet
        open={picker === "model"}
        title={t("modelsSettings.mobileBotTitle", { name: shown.name })}
        closeLabel={t("modelsSettings.close")}
        value={shown.model ?? NONE}
        onClose={() => setPicker(null)}
        onSelect={(id) =>
          save.mutate({
            model: id === NONE ? null : id,
            effort: id !== NONE && reasoningIds.has(id) ? botEffort : null,
          })
        }
        groups={[
          {
            options: [
              {
                id: NONE,
                label: t("modelsSettings.perBotGlobalOption"),
                detail: globalModel ?? undefined,
              },
            ],
          },
          ...modelGroups.map((group) => ({
            caption: group.name,
            options: group.models.map((model) => ({
              id: model.id,
              label: model.id,
              detail: model.reasoning ? t("modelsSettings.reasoning") : t("modelsSettings.fast"),
            })),
          })),
        ]}
      />

      <MobileChoiceSheet
        open={picker === "effort"}
        title={t("modelsSettings.mobileEffortPickerTitle")}
        closeLabel={t("modelsSettings.close")}
        value={botEffort ?? NONE}
        onClose={() => setPicker(null)}
        onSelect={(id) =>
          save.mutate({
            model: shown.model,
            effort: isHermesReasoningEffort(id) ? id : null,
          })
        }
        groups={[
          {
            options: [
              { id: NONE, label: t("modelsSettings.perBotEffortDefault") },
              ...HERMES_REASONING_EFFORTS.map((effort) => ({
                id: effort as string,
                label: HERMES_REASONING_EFFORT_LABELS[effort],
              })),
            ],
          },
        ]}
      />
    </>
  );
}

/**
 * L'annuaire des fournisseurs, en feuille cherchable.
 *
 * Il vivait dans une boîte à défilement PROPRE, au milieu d'une page qui
 * défilait déjà : deux ascenseurs imbriqués, dont l'intérieur mangeait le
 * geste. Ici il a l'écran, un champ de recherche en tête, et chaque ligne
 * ouvre la boîte de connexion existante.
 */
function MobileProvidersSheet({
  open,
  runtime,
  providers,
  hermesProfile,
  onClose,
  onConnected,
}: {
  open: boolean;
  runtime: RuntimePublicDto;
  providers: RuntimeModelProviderDto[];
  hermesProfile: string | null;
  onClose: () => void;
  onConnected: (slug: string) => void;
}) {
  const { t, formatNumber } = useT();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RuntimeModelProviderDto | null>(null);
  const needle = query.trim().toLowerCase();
  const matching = providers.filter(
    (provider) =>
      needle === ""
      || provider.name.toLowerCase().includes(needle)
      || provider.slug.toLowerCase().includes(needle),
  );
  const connected = matching.filter((provider) => provider.authenticated && provider.sdkInstalled !== false);
  const available = matching.filter((provider) => !provider.authenticated || provider.sdkInstalled === false);

  const row = (provider: RuntimeModelProviderDto) => (
    <li key={provider.slug}>
      <button
        type="button"
        data-inset-grouped-row=""
        onClick={() => setSelected(provider)}
        className={cn(insetGroupedRowClassName, "min-h-14")}
      >
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            provider.authenticated && provider.sdkInstalled !== false ? "bg-pos-700" : "bg-warn-700",
          )}
        />
        <span className="min-w-0 flex-1 py-2.5">
          <span className="block truncate text-left text-[17px] leading-[22px] text-[var(--openedbot-grouped-label)]">
            {provider.name}
          </span>
          <span className="mt-0.5 block truncate text-left text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
            {provider.slug}
            {provider.models.length > 0
              ? ` · ${t("modelsSettings.modelCount", { count: formatNumber(provider.models.length) })}`
              : ""}
          </span>
        </span>
        {provider.isCurrent ? <ToneBadge tone="success">{t("modelsSettings.active")}</ToneBadge> : null}
        {provider.sdkInstalled === false ? <ToneBadge tone="warning">{t("modelsSettings.sdkMissing")}</ToneBadge> : null}
        <IconChevronRight aria-hidden className="size-5 shrink-0 text-[var(--openedbot-grouped-chevron)]" />
      </button>
    </li>
  );

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={t("modelsSettings.mobileProvidersTitle")}
        description={t("modelsSettings.providerConnectedCount", {
          count: formatNumber(providers.filter((provider) => provider.authenticated && provider.sdkInstalled !== false).length),
        })}
        closeLabel={t("modelsSettings.close")}
        bodyClassName="px-0 py-0"
        className="h-[calc(100dvh-var(--openedbot-safe-top)-2.5rem)]"
      >
        <div className="sticky top-0 z-10 bg-[var(--openedbot-grouped-canvas)] px-4 pb-2">
          <div className="relative">
            <IconSearch
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-[var(--openedbot-grouped-caption)]"
            />
            <Input
              type="search"
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("modelsSettings.providerSearchPlaceholder")}
              aria-label={t("modelsSettings.providerSearchPlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        {matching.length === 0 ? (
          <p className="px-8 pt-6 text-[15px] leading-5 text-[var(--openedbot-grouped-caption)]">
            {t("modelsSettings.providerSearchEmpty")}
          </p>
        ) : (
          <div className="pb-4">
            {connected.length > 0 ? (
              <InsetGroupedSection caption={t("modelsSettings.providerGroupConnected")} className="pt-0">
                {connected.map(row)}
              </InsetGroupedSection>
            ) : null}
            {available.length > 0 ? (
              <InsetGroupedSection caption={t("modelsSettings.providerGroupAvailable")}>
                {available.map(row)}
              </InsetGroupedSection>
            ) : null}
          </div>
        )}
      </Dialog>

      <ProviderConfigDialog
        runtime={runtime}
        provider={selected}
        hermesProfile={hermesProfile}
        onClose={() => setSelected(null)}
        onConnected={(slug) => {
          setSelected(null);
          onConnected(slug);
        }}
      />
    </>
  );
}
