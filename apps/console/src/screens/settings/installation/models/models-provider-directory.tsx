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
import { useT } from "../../../../lib/i18n";
import { BUTTON, ListSection, ToneBadge } from "../../../../components/settings/primitives";
import { useProviderIncident } from "../../../../components/provider-incident-banner";
import { ProviderAccessBadge } from "./provider-badges";

/** The provider serves the runs: connected, and its connector is installed. */
function usable(provider: RuntimeModelProviderDto): boolean {
  return provider.authenticated && provider.sdkInstalled !== false;
}

/** « OAuth · 12 modèles »: the method and the model count on one line. */
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
  // Hermes keeps `authenticated` on a revoked credential: the incident wins.
  const incident = useProviderIncident(provider.slug);
  const broken = incident !== null || provider.sdkInstalled === false;
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-3" data-provider-row={provider.slug}>
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
 * The desktop « Fournisseurs » block: only those that are connected, with
 * their method, their model count and the state of their access. The rest of the
 * Hermes catalog (dozens of entries) no longer crowds the page: it
 * opens in a window, from « Connecter un fournisseur ».
 */
export function ConnectedProviders({
  providers,
  defaultProvider,
  onManage,
  onBrowse,
}: {
  providers: RuntimeModelProviderDto[];
  /** The provider the runs use by default (chosen here or by Hermes). */
  defaultProvider: string | null;
  onManage: (slug: string) => void;
  onBrowse: () => void;
}) {
  const { t } = useT();
  // A connected provider whose connector is missing stays listed: it
  // would fail every run, and this is where one sees it and repairs it.
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
    // A settings list, flat in its card (`DESIGN.md` › Bureau).
    <div data-models-providers="">
      <ListSection
        title={t("modelsSettings.providersConnectedTitle", { count: connected.length })}
        action={
          <button type="button" className={BUTTON.soft} onClick={onBrowse}>
            <IconPlus aria-hidden className="size-4" />
            {t("modelsSettings.providerConnectNew")}
          </button>
        }
      >
        {connected.length === 0 ? (
          <li className="px-4 py-3 text-sm text-muted-foreground">{t("modelsSettings.providersConnectedNone")}</li>
        ) : (
          connected.map((provider) => (
            <ConnectedProviderRow
              key={provider.slug}
              provider={provider}
              isDefault={provider.slug === defaultProvider}
              onManage={onManage}
            />
          ))
        )}
      </ListSection>
    </div>
  );
}

/**
 * The full provider catalog, in a window: search, the
 * connected ones, those to connect, then at the bottom, greyed out, those whose connector
 * is not installed on the server (the provider's window says how to
 * install it). Choosing an entry closes the catalog and opens its connection.
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
      {/* No access pill: the group title already says it. */}
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
