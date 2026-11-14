import { useState } from "react";
import { IconTool } from "@tabler/icons-react";
import { Switch, cn, toast } from "@openedbot/browser-ui-kit";
import type { RuntimeIntegrationInventoryDto, RuntimeIntegrationToolsetDto } from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import { ToneBadge } from "../../../../components/settings/primitives";
import { matchesQuery } from "./connectors-catalog-model";
import { ToolsetDialog, toolsetStatusMap, useToolsetToggle } from "./connectors-parts";

/** The leading emoji of a Hermes label (« 👁️ Vision / Image Analysis »), with its variant selectors and joiners. */
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u;

/**
 * Hermes prefixes the label of most of its toolsets with an emoji: it
 * becomes the row's tile, and the name is read without it. With no emoji, the
 * tile takes a tool glyph.
 */
export function splitToolsetLabel(label: string): { glyph: string | null; name: string } {
  const match = LEADING_EMOJI.exec(label);
  if (!match) return { glyph: null, name: label };
  const name = label.slice(match[0].length).trim();
  return name ? { glyph: match[1]!, name } : { glyph: null, name: label };
}

/**
 * Settings › Connectors › Tools, on the model of the reference app's lists: two
 * groups, « Actifs » then « Désactivés », each followed by its count, a
 * hairline between them and no card. The « Prêt » pill repeated on every
 * row goes away (the group says it); only « Configuration requise » stays,
 * because it asks for a gesture. A disabled row has its name dimmed.
 *
 * These toolsets are the host root's: a bot with a profile has its own
 * (Gérer le bot), which is why the note sits under the title.
 */
export function ToolsTab({ data, query }: { data: RuntimeIntegrationInventoryDto; query: string }) {
  const { t } = useT();
  const [selected, setSelected] = useState<RuntimeIntegrationToolsetDto | null>(null);
  const toolsets = data.toolsets ?? [];
  if (toolsets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {data.toolsets === null ? t("connectorsPage.toolsEmpty") : t("connectorsSettings.runtimeEmpty")}
      </p>
    );
  }
  const kept = toolsets.filter((toolset) =>
    matchesQuery({ name: toolset.label, description: `${toolset.name} ${toolset.description ?? ""}` }, query));
  if (kept.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("connectorsPage.noMatch", { query: query.trim() })}</p>;
  }
  const groups = [
    { key: "enabled", title: t("connectorsPage.toolsGroupEnabled"), entries: kept.filter((toolset) => toolset.enabled) },
    { key: "disabled", title: t("connectorsPage.toolsGroupDisabled"), entries: kept.filter((toolset) => !toolset.enabled) },
  ].filter((group) => group.entries.length > 0);
  return (
    <div className="space-y-5">
      <p className="px-2 text-xs leading-5 text-muted-foreground">{t("connectorsPage.toolsScope")}</p>
      {groups.map((group) => {
        const id = `connectors-tools-${group.key}`;
        return (
          <section
            key={group.key}
            aria-labelledby={id}
            className="@container space-y-2 border-t border-border/60 pt-5 first:border-t-0 first:pt-0"
          >
            <h3 id={id} className="flex items-baseline gap-2 px-2 text-sm font-semibold tracking-tight text-foreground">
              {group.title}
              <span className="font-normal tabular-nums text-muted-foreground">{group.entries.length}</span>
            </h3>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 @xl:grid-cols-2">
              {group.entries.map((toolset) => (
                <ToolsetRow
                  key={toolset.name}
                  toolset={toolset}
                  canManage={data.management.capabilities.toolsets}
                  onOpen={() => setSelected(toolset)}
                />
              ))}
            </ul>
          </section>
        );
      })}
      <ToolsetDialog toolset={selected} onClose={() => setSelected(null)} canManage={data.management.capabilities.toolsets} />
    </div>
  );
}

/**
 * A row: the button opens the detail; the switch, on the right, toggles
 * the toolset on the root when the host allows it (`toolset_management`,
 * toolset adjustable on `api_server`, not forbidden to activate). Otherwise no
 * switch: the detail says why. `applied: false` (the host wrote
 * and rereads the opposite) is a displayed failure, never an assumed success.
 */
function ToolsetRow({ toolset, canManage, onOpen }: { toolset: RuntimeIntegrationToolsetDto; canManage: boolean; onOpen: () => void }) {
  const { t } = useT();
  const toggle = useToolsetToggle();
  const { glyph, name } = splitToolsetLabel(toolset.label);
  const needsSetup = toolset.status === "configuration_required";
  const status = toolsetStatusMap(t);
  const switchable = canManage && toolset.settable && !(toolset.forbidden && !toolset.enabled);
  const flip = (enabled: boolean) => toggle.mutate({ name: toolset.name, enabled }, {
    onSuccess: (result) => {
      if (!result.applied) toast.error(t("connectorsSettings.toolsetNotApplied"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t("connectorsSettings.loadError"));
    },
  });
  return (
    <li data-toolset-row="" className="flex min-w-0 items-center gap-2 rounded-xl pe-2 transition-colors hover:bg-muted/60">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-muted text-muted-foreground",
            !toolset.enabled && "opacity-60 grayscale",
          )}
        >
          {glyph ? <span className="text-[18px] leading-none">{glyph}</span> : <IconTool className="size-[18px]" stroke={1.75} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-medium", toolset.enabled ? "text-foreground" : "text-muted-foreground")}>
            {name}
          </span>
          <span className="block truncate text-xs leading-5 text-muted-foreground">{toolset.description || toolset.name}</span>
        </span>
        {needsSetup ? <ToneBadge tone={status.configuration_required.tone}>{status.configuration_required.label}</ToneBadge> : null}
      </button>
      {switchable ? (
        <Switch
          checked={toggle.isPending ? toggle.variables.enabled : toolset.enabled}
          disabled={toggle.isPending}
          aria-label={t(toolset.enabled ? "connectorsPage.toolsetSwitchOff" : "connectorsPage.toolsetSwitchOn", { name })}
          onCheckedChange={flip}
        />
      ) : null}
    </li>
  );
}
