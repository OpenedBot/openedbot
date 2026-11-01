import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, useIsMobile } from "@openedbot/browser-ui-kit";
import type {
  BotSkillDto,
  RuntimeIntegrationInventoryDto,
  RuntimeIntegrationToolsetDto,
} from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { McpPanel } from "./connectors-mcp";
import {
  BUTTON,
  CopyButton,
  Note,
  ToneBadge,
  type Tone,
} from "../../../components/settings/primitives";

/**
 * Les pièces communes à Réglages › Connecteurs, bureau et téléphone : les
 * alertes d'inventaire, la boîte des serveurs MCP de l'hôte, le détail d'un
 * toolset (avec sa bascule) et celui d'une skill.
 */

export function McpDialog({
  open,
  onClose,
  inventory,
}: {
  open: boolean;
  onClose: () => void;
  inventory: RuntimeIntegrationInventoryDto;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  // La largeur ne se fixe QUE sur desktop : `className` passe après le
  // The mobile sheet's `max-w-none` should win on tablets. On desktop, use a
  // wider dialog for the catalogue tables, which show names, descriptions and status.
  const width = isMobile ? undefined : inventory.management.capabilities.mcp ? "max-w-5xl" : "max-w-2xl";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("connectorsSettings.mcpTitle")}
      description={t("connectorsSettings.mcpDescription")}
      closeLabel={t("common.close")}
      className={width}
      footer={<button type="button" className={BUTTON.primary} onClick={onClose}>{t("common.close")}</button>}
    >
      <div className="space-y-4">
        {/* Le panneau porte l'objet réel : les serveurs de l'hôte. Sa lecture
            coûteuse reste montée uniquement à l'ouverture de ce dialogue. */}
        {inventory.management.capabilities.mcp ? (
          <Note tone="info">
            <strong>{t("connectorsSettings.managementWritable")}</strong>
            <span className="ms-2">{t("connectorsSettings.managementWritableDescription")}</span>
          </Note>
        ) : (
          <Note tone="warning">{t("connectorsSettings.mcpUnavailable")}</Note>
        )}
        {inventory.management.capabilities.mcp ? (
          <McpPanel />
        ) : (
          <dl className="grid gap-3">
            <Command label={t("connectorsSettings.commandInspectMcp")} value="hermes mcp list" />
            <Command label={t("connectorsSettings.commandMcp")} value="hermes mcp picker" />
          </dl>
        )}
      </div>
    </Dialog>
  );
}

export function InventoryAlerts({
  data,
}: {
  data: RuntimeIntegrationInventoryDto;
}) {
  const { t } = useT();
  return (
    <>
      {data.inventoryError ? (
        <Note tone="danger" role="alert">{data.inventoryError.message}</Note>
      ) : null}
      {data.runtime && data.support === "unavailable" && !data.inventoryError ? (
        <Note tone="warning">
          <strong>{t("connectorsSettings.inventoryUnavailableTitle")}</strong>
          <span className="ms-2">{t("connectorsSettings.inventoryUnavailableDescription")}</span>
        </Note>
      ) : null}
      {data.support === "partial" ? (
        <Note tone="warning">{t("connectorsSettings.partialWarning")}</Note>
      ) : null}
    </>
  );
}

export function toolsetStatusMap(t: ReturnType<typeof useT>["t"]): Record<RuntimeIntegrationToolsetDto["status"], { label: string; tone: Tone }> {
  return {
    ready: { label: t("connectorsSettings.statusReady"), tone: "success" },
    configuration_required: {
      label: t("connectorsSettings.statusConfigurationRequired"),
      tone: "warning",
    },
    disabled: { label: t("connectorsSettings.statusDisabled"), tone: "neutral" },
  };
}

/**
 * La bascule d'un toolset.
 *
 * `applied` porte tout : l'appel peut réussir alors que l'hôte a relu son
 * inventaire et y a vu le contraire (`agent.disabled_toolsets` neutralise une
 * activation, et `hermes tools` imprime ses refus en sortant quand même en 0).
 * Ce cas s'affiche comme l'échec qu'il est, au lieu du succès qu'on aurait cru.
 */
function useToolsetToggle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; enabled: boolean }) =>
      api.setRuntimeToolset(input.name, input.enabled),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeIntegrations });
    },
  });
}

export function ToolsetToggle({ toolset, canManage }: { toolset: RuntimeIntegrationToolsetDto; canManage: boolean }) {
  const { t } = useT();
  const toggle = useToolsetToggle();
  const failed = toggle.isError
    ? toggle.error instanceof Error ? toggle.error.message : t("connectorsSettings.loadError")
    : toggle.isSuccess && !toggle.data.applied
      ? t("connectorsSettings.toolsetNotApplied")
      : null;

  if (toolset.forbidden && !toolset.enabled) {
    return <p className="text-xs leading-5 text-muted-foreground">{t("connectorsSettings.toolsetForbidden")}</p>;
  }
  if (!toolset.settable) {
    return <p className="text-xs leading-5 text-muted-foreground">{t("connectorsSettings.toolsetNotSettable")}</p>;
  }
  if (!canManage) {
    return <p className="text-xs leading-5 text-muted-foreground">{t("connectorsSettings.toolsetReadOnly")}</p>;
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        className={toolset.enabled ? BUTTON.secondary : BUTTON.primary}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate({ name: toolset.name, enabled: !toolset.enabled })}
      >
        {toggle.isPending
          ? t("connectorsSettings.toolsetPending")
          : toolset.enabled
            ? t("connectorsSettings.toolsetDisable")
            : t("connectorsSettings.toolsetEnable")}
      </button>
      {failed ? <Note tone="danger" role="alert">{failed}</Note> : null}
    </div>
  );
}

export function ToolsetDialog({
  toolset,
  onClose,
  canManage,
}: {
  toolset: RuntimeIntegrationToolsetDto | null;
  onClose: () => void;
  canManage: boolean;
}) {
  const { t } = useT();
  const status = toolsetStatusMap(t);
  const state = toolset ? status[toolset.status] : null;
  return (
    <Dialog
      open={toolset !== null}
      onClose={onClose}
      title={toolset?.label}
      description={toolset?.name}
      closeLabel={t("common.close")}
      className="max-w-lg"
      footer={<button type="button" className={BUTTON.primary} onClick={onClose}>{t("common.close")}</button>}
    >
      {toolset ? (
        <div className="space-y-3">
          {state ? <ToneBadge tone={state.tone}>{state.label}</ToneBadge> : null}
          <p className="text-sm leading-6 text-foreground/80">
            {toolset.description || t("connectorsSettings.noDescription")}
          </p>
          <ToolsetToggle toolset={toolset} canManage={canManage} />
          {toolset.tools.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("connectorsSettings.toolsCount", { count: toolset.tools.length })}
              </p>
              <ul className="mt-2 flex flex-wrap gap-1" aria-label={t("connectorsSettings.toolsCount", { count: toolset.tools.length })}>
                {toolset.tools.map((tool) => (
                  <li key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{tool}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

export function groupSkills(skills: BotSkillDto[]): Array<[string, BotSkillDto[]]> {
  const values = new Map<string, BotSkillDto[]>();
  for (const skill of skills) {
    const category = skill.category ?? "";
    values.set(category, [...(values.get(category) ?? []), skill]);
  }
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function SkillDialog({
  skill,
  onClose,
}: {
  skill: BotSkillDto | null;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog
      open={skill !== null}
      onClose={onClose}
      title={skill?.name}
      closeLabel={t("common.close")}
      className="max-w-lg"
      footer={<button type="button" className={BUTTON.primary} onClick={onClose}>{t("common.close")}</button>}
    >
      {skill ? (
        <div className="space-y-3">
          <ToneBadge tone="neutral">
            {skill.category || t("connectorsSettings.uncategorized")}
          </ToneBadge>
          <p className="text-sm leading-6 text-foreground/80">
            {skill.description || t("connectorsSettings.noDescription")}
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}

export function Command({ label, value }: { label: string; value: string }) {
  const { t } = useT();
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2">
        <code className="min-w-0 break-all font-mono text-xs">{value}</code>
        <CopyButton
          value={value}
          copyLabel={t("connectorsSettings.copyCommand")}
          copiedLabel={t("connectorsSettings.commandCopied")}
          className="shrink-0 text-xs font-medium text-accent-700 hover:underline"
        />
      </dd>
    </div>
  );
}
