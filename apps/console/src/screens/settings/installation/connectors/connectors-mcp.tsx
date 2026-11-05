import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { Input, useIsMobile } from "@openedbot/browser-ui-kit";
import type { RuntimeIntegrationMcpCatalogEntryDto, RuntimeIntegrationMcpDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { BUTTON, Note, SettingsCard } from "../../../../components/settings/primitives";
import {
  InsetGroupedRow,
  InsetGroupedSection,
  InsetGroupedStatic,
} from "../../../../components/mobile/inset-grouped";
import { filterCatalog } from "./connectors-mcp-shared";
import { McpCatalogTable, McpServerTable } from "./connectors-mcp-tables";
import { McpActionRow, McpCatalogSheet, McpServerListRow, McpServerSheet } from "./connectors-mcp-mobile";
import { McpOauthDialog } from "./connectors-mcp-oauth";
import { GatewayRestartCard } from "./connectors-mcp-gateway";
import { McpAddDialog, McpInstallDialog, type AddInput } from "./connectors-mcp-dialogs";

export { filterCatalog } from "./connectors-mcp-shared";
export { McpOauthDialog } from "./connectors-mcp-oauth";
export { GatewayRestartCard } from "./connectors-mcp-gateway";
export { McpInstallDialog } from "./connectors-mcp-dialogs";

/**
 * Administration des serveurs MCP, depuis openedbot, par l'opérateur de l'hôte.
 *
 * Ce panneau n'existe que si l'hôte a ANNONCÉ `mcp_management` : sans lui,
 * `available` vaut `false` et on dit ce qui manque plutôt que d'afficher un
 * formulaire dont l'envoi échouerait. Aucun secret ne revient jamais ici : un
 * jeton part vers l'hôte et n'en ressort pas.
 *
 * Le formulaire ne propose PAS de serveur stdio : ajouter un serveur en
 * commande locale, c'est nommer un exécutable et son argv, et le lien ne porte
 * rien de tel vers la machine du client. Les serveurs en commande locale
 * arrivent par le catalogue approuvé, dont l'hôte détient la liste.
 */
export function McpPanel() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  // Le serveur dont l'autorisation OAuth est ouverte, ou rien.
  const [oauthServer, setOauthServer] = useState<string | null>(null);
  // Lue ICI et pas dans la page : cette lecture démarre un interpréteur sur
  // l'hôte, et ce composant n'est monté que quand le panneau s'ouvre.
  const query = useQuery({ queryKey: queryKeys.runtimeMcp, queryFn: api.runtimeMcpFresh });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeMcp });
    // Une écriture MCP change aussi ce que porte la plateforme : l'inventaire
    // de la page n'est plus à jour non plus, ni l'état du gateway, qui vient
    // de gagner une modification qu'il n'a pas chargée.
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeIntegrations });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
  };
  const onError = (error: unknown) => {
    setFailure(error instanceof Error ? error.message : t("connectorsSettings.loadError"));
  };

  const remove = useMutation({
    mutationFn: (name: string) => api.removeRuntimeMcpServer(name),
    onSuccess: () => { setFailure(null); invalidate(); },
    onError,
  });
  const install = useMutation({
    mutationFn: (entry: { name: string; env: Record<string, string> }) =>
      api.installRuntimeMcpCatalogEntry(entry.name, entry.env),
    onSuccess: () => { setFailure(null); invalidate(); },
    onError,
  });
  const add = useMutation({
    mutationFn: api.addRuntimeMcpServer,
    onSuccess: () => { setFailure(null); invalidate(); },
    onError,
  });

  if (query.isPending) {
    return (
      <SettingsCard className="space-y-3">
        <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpServersTitle")}</p>
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </SettingsCard>
    );
  }
  // Une lecture ratée ne prouve rien : elle ne se lit ni « aucun connecteur »,
  // ni « l'hôte ne sait pas faire ».
  if (query.isError || !query.data) {
    return (
      <SettingsCard className="space-y-3">
        <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpServersTitle")}</p>
        <Note tone="danger" role="alert">{t("connectorsSettings.loadError")}</Note>
      </SettingsCard>
    );
  }
  const mcp = query.data;
  if (!mcp.available) {
    return (
      <SettingsCard className="space-y-3">
        <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpServersTitle")}</p>
        <Note tone="warning">{t("connectorsSettings.mcpUnavailable")}</Note>
      </SettingsCard>
    );
  }

  const installed = new Set(mcp.servers.map((server) => server.name));
  const busy = remove.isPending || install.isPending || add.isPending;

  /* Le gateway ne lit ses serveurs MCP qu'au démarrage : la carte dit si une
     modification l'attend, et porte le seul redémarrage que le lien sait
     faire. Elle n'existe que si l'hôte l'annonce.

     Sur téléphone elle passe SOUS les listes : le redémarrage est la
     conséquence d'une modification, pas la porte d'entrée de l'écran, et le
     poser en tête repoussait les serveurs (ce que l'opérateur vient lire)
     hors du premier écran. */
  const gateway = mcp.capabilities.gatewayRestart
    ? <GatewayRestartCard onRestarted={invalidate} />
    : null;

  return (
    <>
      {isMobile ? null : gateway}
      <McpPanelView
        mcp={mcp}
        installed={installed}
        busy={busy}
        failure={failure}
        addPending={add.isPending}
        installingName={install.isPending ? (install.variables?.name ?? null) : null}
        removingName={remove.isPending ? (remove.variables ?? null) : null}
        onAdd={(input) => add.mutate(input)}
        onInstall={(name, env) => install.mutate({ name, env })}
        onAuthorize={(name) => setOauthServer(name)}
        /* La confirmation appartient à la VUE, pas au pilote : le tableau
           bureau garde le `confirm()` du navigateur, la feuille de détail du
           téléphone pose sa propre alerte : une boîte système grise au milieu
           d'une PWA installée se lit comme une page web. */
        onRemove={(name) => remove.mutate(name)}
      />
      {isMobile ? gateway : null}
      <McpOauthDialog server={oauthServer} onClose={() => setOauthServer(null)} onConnected={invalidate} />
    </>
  );
}

/**
 * La vue, séparée des mutations pour être montable en test sans réseau.
 *
 * Deux mises en page, un seul modèle. Sur desktop les serveurs et le catalogue
 * sont des TABLEAUX : vingt entrées de catalogue empilées en cartes se lisent
 * au défilement, alignées en colonnes elles se comparent d'un regard.
 *
 * Sur téléphone, ni tableau ni cartes : deux listes groupées iOS. Les cartes
 * disaient la vraie hiérarchie à l'envers : un serveur configuré contre
 * vingt-quatre entrées de catalogue, chacune en boîte grise avec son bouton
 * « Installer », donc le seul fait que l'opérateur vient lire tenait sur un
 * sixième de l'écran et le reste était un défilement sans filtre. Le catalogue
 * est passé derrière UNE ligne, qui ouvre une feuille cherchable.
 *
 * Brancher un serveur ouvre une boîte À PART, jamais un formulaire déplié dans
 * la ligne : les variables d'une entrée (base URL, clé d'API) sont une saisie
 * en soi, et les afficher inline pousse le reste du catalogue hors de l'écran
 * pendant qu'on tape.
 */
export function McpPanelView({
  mcp,
  installed,
  busy,
  failure,
  addPending,
  installingName,
  removingName,
  onAdd,
  onInstall,
  onAuthorize,
  onRemove,
}: {
  mcp: RuntimeIntegrationMcpDto;
  installed: Set<string>;
  busy: boolean;
  failure: string | null;
  addPending: boolean;
  installingName: string | null;
  removingName: string | null;
  onAdd: (input: AddInput) => void;
  onInstall: (name: string, env: Record<string, string>) => void;
  onAuthorize: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const { t, formatNumber } = useT();
  const isMobile = useIsMobile();
  const [adding, setAdding] = useState(false);
  const oauthEnabled = mcp.capabilities.oauth;
  const [installEntry, setInstallEntry] = useState<RuntimeIntegrationMcpCatalogEntryDto | null>(null);
  // Téléphone : la feuille du catalogue, et le serveur dont le détail est
  // ouvert. Un serveur retiré disparaît de `mcp.servers` : la feuille se ferme
  // alors d'elle-même, sans que le retrait ait à la piloter.
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  // Le filtre du catalogue, partagé par la feuille et le tableau : vingt-quatre
  // entrées sans champ de recherche se parcourent, elles ne se trouvent pas.
  const [query, setQuery] = useState("");
  const matching = filterCatalog(mcp.catalog, query);
  const detailServer = mcp.servers.find((server) => server.name === detail) ?? null;

  const alerts = (
    <>
      {/* L'échec d'une lecture et l'échec d'une écriture se disent tous les
          deux, et séparément : l'un dit « je ne sais pas », l'autre « ça n'a
          pas eu lieu ». */}
      {mcp.error ? <Note tone="danger" role="alert">{mcp.error.message}</Note> : null}
      {failure ? <Note tone="danger" role="alert">{failure}</Note> : null}
    </>
  );

  const dialogs = (
    <>
      <McpAddDialog
        open={adding}
        busy={busy}
        pending={addPending}
        onClose={() => setAdding(false)}
        onSubmit={(input) => {
          onAdd(input);
          setAdding(false);
        }}
      />
      <McpInstallDialog
        entry={installEntry}
        busy={busy}
        pending={installEntry !== null && installingName === installEntry.name}
        onClose={() => setInstallEntry(null)}
        onSubmit={(env) => {
          if (!installEntry) return;
          onInstall(installEntry.name, env);
          setInstallEntry(null);
          setCatalogOpen(false);
        }}
      />
    </>
  );

  if (isMobile) {
    return (
      <>
        {alerts}

        <InsetGroupedSection
          caption={t("connectorsSettings.mcpServersTitle")}
          footer={t("connectorsSettings.mcpServersDescription")}
        >
          {mcp.servers.length === 0 ? (
            <InsetGroupedStatic label={t("connectorsSettings.mcpNoServerRow")} />
          ) : (
            mcp.servers.map((server) => (
              <McpServerListRow
                key={server.name}
                server={server}
                onOpen={() => setDetail(server.name)}
              />
            ))
          )}
          {/* L'ajout est la DERNIÈRE LIGNE du groupe, pas un bouton posé dans
              l'en-tête de la carte : c'est là qu'iOS met « Ajouter un compte »,
              et la barre du bas de l'écran porte déjà deux CTA. */}
          <McpActionRow
            icon={IconPlus}
            label={t("connectorsSettings.mcpAddTitle")}
            disabled={busy}
            onClick={() => setAdding(true)}
          />
        </InsetGroupedSection>

        {mcp.catalog.length === 0 ? (
          <p className="px-8 pt-4 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
            {t("connectorsSettings.mcpCatalogEmpty")}
          </p>
        ) : (
          <InsetGroupedSection footer={t("connectorsSettings.mcpCatalogDescription")}>
            <InsetGroupedRow
              label={t("connectorsSettings.mcpCatalogTitle")}
              value={t("connectorsSettings.mcpCatalogCount", {
                count: formatNumber(mcp.catalog.length),
              })}
              aria-label={t("connectorsSettings.mcpCatalogOpen")}
              disabled={busy}
              onClick={() => {
                setQuery("");
                setCatalogOpen(true);
              }}
            />
          </InsetGroupedSection>
        )}

        <McpServerSheet
          server={detailServer}
          busy={busy}
          oauthEnabled={oauthEnabled}
          removing={removingName === detail}
          onAuthorize={() => {
            if (detail === null) return;
            setDetail(null);
            onAuthorize(detail);
          }}
          onRemove={() => {
            if (detail !== null) onRemove(detail);
          }}
          onClose={() => setDetail(null)}
        />
        <McpCatalogSheet
          open={catalogOpen}
          entries={matching}
          total={mcp.catalog.length}
          installed={installed}
          busy={busy}
          query={query}
          onQuery={setQuery}
          onClose={() => setCatalogOpen(false)}
          onOpen={setInstallEntry}
        />
        {dialogs}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {alerts}

      <SettingsCard className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpServersTitle")}</p>
            <p className="text-sm leading-6 text-muted-foreground">
              {t("connectorsSettings.mcpServersDescription")}
            </p>
          </div>
          <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => setAdding(true)}>
            {t("connectorsSettings.mcpAddTitle")}
          </button>
        </div>
        {mcp.servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("connectorsSettings.mcpServersEmpty")}</p>
        ) : (
          <McpServerTable
            servers={mcp.servers}
            busy={busy}
            oauthEnabled={oauthEnabled}
            removingName={removingName}
            onAuthorize={onAuthorize}
            onRemove={onRemove}
          />
        )}
      </SettingsCard>

      <SettingsCard className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpCatalogTitle")}</p>
            <p className="text-sm leading-6 text-muted-foreground">
              {t("connectorsSettings.mcpCatalogDescription")}
            </p>
          </div>
          {/* Le même filtre que la feuille du téléphone : vingt-quatre lignes
              triées par nom se parcourent aussi mal à la souris qu'au doigt. */}
          {mcp.catalog.length > 0 ? (
            <div className="relative w-full sm:w-64">
              <IconSearch
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("connectorsSettings.mcpCatalogSearch")}
                aria-label={t("connectorsSettings.mcpCatalogSearchLabel")}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ) : null}
        </div>
        {mcp.catalog.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("connectorsSettings.mcpCatalogEmpty")}</p>
        ) : matching.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("connectorsSettings.mcpCatalogNoMatch", { query: query.trim() })}
          </p>
        ) : (
          <McpCatalogTable
            catalog={matching}
            installed={installed}
            busy={busy}
            installingName={installingName}
            onOpen={setInstallEntry}
            onInstall={onInstall}
          />
        )}
      </SettingsCard>

      {dialogs}
    </div>
  );
}
