import { useRef, useState } from "react";
import { RiArrowDownSLine } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";
import type { RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { catalogModelView, providerRail } from "@/lib/bots/model-catalog";
import { useT } from "../../../../lib/i18n";
import { BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "../../../../components/boardui/menu";
import { ModelCatalogPanel } from "../../../../components/model-catalog-panel";
import { PROVIDER_GLYPH } from "../../../../components/composer-model-picker-panels";
import { ProviderIcon } from "../../../../components/provider-icon";

/**
 * A bot's model in the « Un par bot » table. The field has the height and
 * the frame of every select in the settings; it opens the composer's own
 * catalogue (`ModelCatalogPanel`): the provider rail by brand mark, the
 * chosen provider's models, a search across all of them. A `Select` listed
 * thirty bare ids in a trigger-wide menu that ran off the window.
 *
 * The popover flips above the field when the window has no room below
 * (`collisionPadding`), and the trigger shows the provider's mark, so two
 * providers' ids are never mistaken for one another.
 *
 * `null` = follow the default model, offered first and named.
 */
export function BotModelField({
  id,
  ariaLabel,
  providers,
  value,
  globalModel,
  disabled,
  onValueChange,
}: {
  id: string;
  ariaLabel: string;
  providers: RuntimeModelProviderDto[];
  value: string | null;
  globalModel: string | null;
  disabled: boolean;
  onValueChange: (value: string | null) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const groups = catalogModelView(providers, [value, globalModel]).groups;
  const shownModel = value ?? globalModel;
  const provider = groups.find((group) => group.models.some((model) => model.id === shownModel))?.slug ?? null;
  const defaultLabel = t("modelsSettings.perBotDefaultOption");

  return (
    <BuiPopover open={open} onOpenChange={setOpen}>
      <BuiPopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label={ariaLabel}
          disabled={disabled}
          data-bot-model-field=""
          className={cn(
            "flex h-11 w-full min-w-0 cursor-pointer items-center gap-2 rounded-[10px] border border-input bg-card px-3 text-sm text-foreground shadow-[var(--shadow-xs)] transition-colors outline-none select-none",
            "hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
            "disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted-foreground disabled:[-webkit-text-fill-color:currentColor]",
          )}
        >
          {provider ? (
            <ProviderIcon provider={provider} decorative colored className={cn("size-4 shrink-0", PROVIDER_GLYPH)} />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-left whitespace-nowrap">
            {value === null ? (
              <>
                {defaultLabel}
                {globalModel ? <span className="text-muted-foreground"> · {globalModel}</span> : null}
              </>
            ) : value}
          </span>
          <RiArrowDownSLine
            aria-hidden
            className={cn("size-4 shrink-0 text-muted-foreground/70 transition-transform duration-200", open && "rotate-180")}
          />
        </button>
      </BuiPopoverTrigger>
      <BuiPopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        className="bui-popover-ref bui-popover-ref-panel overflow-clip p-0"
        // Focus on the checked model, not on the rail's first tab (whose tooltip would open).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const list = listRef.current;
          (list?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? list?.querySelector<HTMLElement>('[role="radio"]'))?.focus();
        }}
      >
        <ModelCatalogPanel
          layout="popover"
          className="h-[320px] w-[360px]"
          groups={groups}
          rail={providerRail(providers)}
          selectedModel={value}
          openOnModel={shownModel}
          globalLabel={defaultLabel}
          globalDetail={globalModel ?? t("composer.modelUnavailable")}
          disabled={disabled}
          onModelChange={(next) => {
            setOpen(false);
            if (next !== value) onValueChange(next);
          }}
          onClose={() => setOpen(false)}
          listRef={listRef}
        />
      </BuiPopoverContent>
    </BuiPopover>
  );
}
