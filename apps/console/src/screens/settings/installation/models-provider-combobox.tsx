import { IconChevronRight } from "@tabler/icons-react";
import { CommandGroup, CommandItem } from "@openedbot/browser-ui-kit";
import type { RuntimeModelDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { useT } from "../../../lib/i18n";
import { modelsByRelease } from "../../../lib/model-catalog";
import { NONE } from "./models-shared";
import { SearchCombobox } from "./models-search-combobox";

function providerChoiceLabel(
  provider: RuntimeModelProviderDto,
  t: ReturnType<typeof useT>["t"],
): string {
  return `${provider.name} · ${provider.sdkInstalled === false
    ? t("modelsSettings.sdkMissing")
    : provider.authenticated
      ? t("modelsSettings.modelCount", { count: provider.models.length })
      : t("modelsSettings.notConnected")}`;
}

/** Le libellé d'un fournisseur, et dessous la raison qu'Hermes donne quand il en donne une. */
function ProviderChoiceText({ provider }: { provider: RuntimeModelProviderDto }) {
  const { t } = useT();
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{providerChoiceLabel(provider, t)}</span>
      {provider.warning ? (
        <span className="block truncate text-xs text-muted-foreground" title={provider.warning}>
          {provider.warning}
        </span>
      ) : null}
    </span>
  );
}

/** Combobox fournisseur : la mécanique du champ vit dans `SearchCombobox`. */
export function ProviderPreferenceCombobox({
  providers,
  value,
  disabled,
  onValueChange,
  id = "runtime-model-provider",
  noneLabel,
  onConnectProvider,
}: {
  providers: RuntimeModelProviderDto[];
  value: string | null;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  /**
   * Un fournisseur non connecté n'est pas choisissable, mais il n'est pas une
   * impasse : le clic ouvre sa connexion (OAuth ou clé API).
   */
  onConnectProvider?: (slug: string) => void;
  id?: string;
  /** Le libellé du choix « aucun fournisseur » : « Laisser Hermes décider » par défaut. */
  noneLabel?: string;
}) {
  const { t } = useT();
  const noneText = noneLabel ?? t("modelsSettings.noPreference");
  const sdkMissing = providers.filter((provider) => provider.sdkInstalled === false);
  const connected = providers.filter((provider) => provider.authenticated && provider.sdkInstalled !== false);
  const available = providers.filter((provider) => !provider.authenticated && provider.sdkInstalled !== false);
  const selected = providers.find((provider) => provider.slug === value) ?? null;

  return (
    <SearchCombobox
      id={id}
      triggerLabel={selected ? providerChoiceLabel(selected, t) : noneText}
      disabled={disabled}
      searchPlaceholder={t("modelsSettings.providerSearchPlaceholder")}
      emptyText={t("modelsSettings.providerSearchEmpty")}
    >
      {(close) => {
        const pick = (next: string) => {
          close();
          onValueChange(next);
        };
        return (
          <>
            <CommandGroup>
              <CommandItem
                value={noneText}
                data-checked={value === null ? true : undefined}
                onSelect={() => pick(NONE)}
              >
                {noneText}
              </CommandItem>
            </CommandGroup>
            {connected.length > 0 ? (
              <CommandGroup heading={t("modelsSettings.providerGroupConnected")}>
                {connected.map((entry) => (
                  <CommandItem
                    key={entry.slug}
                    value={`${entry.name} ${entry.slug}`}
                    data-checked={value === entry.slug ? true : undefined}
                    onSelect={() => pick(entry.slug)}
                  >
                    <ProviderChoiceText provider={entry} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {sdkMissing.length > 0 ? (
              <CommandGroup heading={t("modelsSettings.providerGroupSdkMissing")}>
                {sdkMissing.map((entry) => (
                  <CommandItem
                    key={entry.slug}
                    value={`${entry.name} ${entry.slug}`}
                    disabled
                    className="text-muted-foreground"
                  >
                    <ProviderChoiceText provider={entry} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {available.length > 0 ? (
              <CommandGroup heading={t("modelsSettings.providerGroupNotConnected")}>
                {available.map((entry) => (
                  <CommandItem
                    key={entry.slug}
                    value={`${entry.name} ${entry.slug}`}
                    disabled={!onConnectProvider}
                    className="text-muted-foreground"
                    onSelect={() => {
                      if (!onConnectProvider) return;
                      close();
                      onConnectProvider(entry.slug);
                    }}
                  >
                    <ProviderChoiceText provider={entry} />
                    {onConnectProvider ? <IconChevronRight aria-hidden className="size-4 shrink-0" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </>
        );
      }}
    </SearchCombobox>
  );
}

/**
 * Combobox modèle, jumelle de celle du fournisseur : les modèles du
 * fournisseur choisi, du plus récent au plus ancien et sans doublon d'alias
 * (`modelsByRelease`), filtrables par leur id.
 */
export function ModelPreferenceCombobox({
  models,
  value,
  disabled,
  onValueChange,
  id = "runtime-model-model",
}: {
  models: RuntimeModelDto[];
  value: string | null;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  id?: string;
}) {
  const { t } = useT();
  const ordered = modelsByRelease(models, [value]);
  return (
    <SearchCombobox
      id={id}
      triggerLabel={value ?? t("modelsSettings.noModel")}
      disabled={disabled}
      searchPlaceholder={t("modelsSettings.modelSearchPlaceholder")}
      emptyText={t("modelsSettings.modelSearchEmpty")}
    >
      {(close) => (
        <CommandGroup>
          {ordered.map((model) => (
            <CommandItem
              key={model.id}
              value={model.id}
              data-checked={value === model.id ? true : undefined}
              onSelect={() => {
                close();
                onValueChange(model.id);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{model.id}</span>
              {model.isRuntimeDefault ? (
                <span className="shrink-0 text-xs text-muted-foreground">{t("modelsSettings.defaultBadge")}</span>
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </SearchCombobox>
  );
}
