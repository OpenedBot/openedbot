import { useMemo } from "react";
import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import {
  cn,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
} from "@openedbot/browser-ui-kit";
import type { RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { isKeylessProvider } from "@openedbot/runtimes/domain/runtime/keyless-providers";
import { useT } from "../../../lib/i18n";
import { BUTTON, CardHeading, SettingsCard, ToneBadge } from "../../../components/settings/primitives";
import { useProviderIncident } from "../../../components/provider-incident-banner";
import { ProviderAccessBadge } from "./provider-badges";

/** Le fournisseur sert les runs : connecté, et son connecteur est installé. */
function usable(provider: RuntimeModelProviderDto): boolean {
  return provider.authenticated && provider.sdkInstalled !== false;
}

/** « OAuth · 12 modèles » : la méthode et le nombre de modèles sur une ligne. */
function providerFacts(provider: RuntimeModelProviderDto, t: ReturnType<typeof useT>["t"]): string {
  const method = provider.alwaysAuthenticated
    ? t("modelsSettings.integrated")
    : isKeylessProvider(provider.slug)
      ? t("modelsSettings.methodKeyless")
      : provider.acceptsOauth
        ? t("modelsSettings.methodOauth")
        : provider.acceptsApiKey
          ? t("modelsSettings.methodApiKey")
          : t("modelsSettings.methodCli");
  return provider.models.length > 0
    ? `${method} · ${t("modelsSettings.modelCount", { count: provider.models.length })}`
    : method;
}

function ConnectedProviderRow({
  provider,
  isDefault,
  onManage,
}: {
  provider: RuntimeModelProviderDto;
  isDefault: boolean;
  onManage: (slug: string) => void;
}) {
  const { t } = useT();
  // Hermes garde `authenticated` sur un credential révoqué : l'incident prime.
  const incident = useProviderIncident(provider.slug);
  const broken = incident !== null || provider.sdkInstalled === false;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5" data-provider-row={provider.slug}>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", broken ? "bg-destructive" : "bg-pos-700")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{provider.name}</span>
          {isDefault ? <ToneBadge tone="success">{t("modelsSettings.providerDefaultBadge")}</ToneBadge> : null}
          {broken ? <ProviderAccessBadge provider={provider} /> : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{providerFacts(provider, t)}</span>
      </span>
      <button
        type="button"
        className={cn(broken ? BUTTON.danger : BUTTON.secondary, "shrink-0")}
        onClick={() => onManage(provider.slug)}
      >
        {broken ? t("modelsSettings.providerRepair") : t("modelsSettings.providerManage")}
        <span className="sr-only"> {provider.name}</span>
      </button>
    </li>
  );
}

/**
 * Le bloc « Fournisseurs » du bureau : seulement ceux qui sont connectés, avec
 * leur méthode, leur nombre de modèles et l'état de leur accès. Le reste du
 * catalogue Hermes (des dizaines d'entrées) n'encombre plus la page : il
 * s'ouvre dans une fenêtre, depuis « Connecter un fournisseur ».
 */
export function ConnectedProviders({
  providers,
  defaultProvider,
  onManage,
  onBrowse,
}: {
  providers: RuntimeModelProviderDto[];
  /** Le fournisseur que les runs utilisent par défaut (choisi ici ou par Hermes). */
  defaultProvider: string | null;
  onManage: (slug: string) => void;
  onBrowse: () => void;
}) {
  const { t } = useT();
  // Un fournisseur connecté dont le connecteur manque reste listé : il
  // ferait échouer chaque run, c'est ici qu'on le voit et qu'on le répare.
  const connected = useMemo(
    () => providers
      .filter((provider) => provider.authenticated)
      .sort((left, right) => {
        if ((left.slug === defaultProvider) !== (right.slug === defaultProvider)) return left.slug === defaultProvider ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
    [providers, defaultProvider],
  );
  return (
    <SettingsCard className="space-y-4" data-models-providers="">
      <CardHeading
        title={t("modelsSettings.providersConnectedTitle", { count: connected.length })}
        action={
          <button type="button" className={BUTTON.soft} onClick={onBrowse}>
            <IconPlus aria-hidden className="size-4" />
            {t("modelsSettings.providerConnectNew")}
          </button>
        }
      />
      {connected.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("modelsSettings.providersConnectedNone")}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {connected.map((provider) => (
            <ConnectedProviderRow
              key={provider.slug}
              provider={provider}
              isDefault={provider.slug === defaultProvider}
              onManage={onManage}
            />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

/**
 * Le catalogue complet des fournisseurs, dans une fenêtre : recherche, les
 * connectés, ceux à connecter, puis en bas, grisés, ceux dont le connecteur
 * n'est pas installé sur le serveur (la fenêtre du fournisseur dit comment
 * l'installer). Choisir une entrée ferme le catalogue et ouvre sa connexion.
 */
export function ProviderCatalogDialog({
  open,
  providers,
  onClose,
  onPick,
}: {
  open: boolean;
  providers: RuntimeModelProviderDto[];
  onClose: () => void;
  onPick: (slug: string) => void;
}) {
  const { t } = useT();
  const byName = useMemo(() => [...providers].sort((left, right) => left.name.localeCompare(right.name)), [providers]);
  const connected = byName.filter(usable);
  const available = byName.filter((provider) => !provider.authenticated && provider.sdkInstalled !== false);
  const sdkMissing = byName.filter((provider) => provider.sdkInstalled === false);

  const renderRow = (entry: RuntimeModelProviderDto, muted: boolean) => (
    <CommandItem
      key={entry.slug}
      value={`${entry.name} ${entry.slug}`}
      onSelect={() => onPick(entry.slug)}
      className={cn("min-h-11", muted && "text-muted-foreground")}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{entry.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{providerFacts(entry, t)}</span>
      </span>
      {/* Pas de pastille d'accès : le titre du groupe le dit déjà. */}
      <IconChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </CommandItem>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("modelsSettings.providerCatalogTitle")}
      description={t("modelsSettings.providerCatalogDescription")}
      closeLabel={t("modelsSettings.close")}
      className="max-w-lg"
    >
      <Command className="bg-transparent p-0" data-provider-catalog="">
        <CommandInput placeholder={t("modelsSettings.providerSearchPlaceholder")} data-dialog-autofocus="" />
        <CommandList scrollbar="subtle" className="mt-2 max-h-[min(60vh,28rem)] pr-1">
          <CommandEmpty>{t("modelsSettings.providerSearchEmpty")}</CommandEmpty>
          {connected.length > 0 ? (
            <CommandGroup heading={t("modelsSettings.providerGroupConnected")}>
              {connected.map((entry) => renderRow(entry, false))}
            </CommandGroup>
          ) : null}
          {available.length > 0 ? (
            <CommandGroup heading={t("modelsSettings.providerGroupAvailable")}>
              {available.map((entry) => renderRow(entry, false))}
            </CommandGroup>
          ) : null}
          {sdkMissing.length > 0 ? (
            <CommandGroup heading={t("modelsSettings.providerGroupSdkMissing")}>
              {sdkMissing.map((entry) => renderRow(entry, true))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </Dialog>
  );
}
