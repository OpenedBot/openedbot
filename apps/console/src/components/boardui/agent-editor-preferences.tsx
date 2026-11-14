import { useMemo, useState } from "react";
import { RiArrowDownSLine, RiGlobalLine, RiNotification3Line } from "@remixicon/react";
import { BOT_REPLY_LANGUAGES, type BotDto, type BotReplyLanguage, type UpdateBotInput } from "@openedbot/contracts-api";
import { Switch, cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./menu";

/**
 * The agent editor's preferences (`agent-editor-panel`): the reply
 * language and the finish notice, written at once, plus the template
 * dropdown that the Voice card reuses.
 */
type PreferencesBot = Pick<BotDto, "id" | "replyLanguage" | "notifyOnFinish">;

export type SelectOption = { value: string; label: string };

/** The template dropdown: a bordered button, a list of 240 px at most. */
export function BuiSelect({
  value,
  options,
  label,
  onChange,
  className,
}: {
  value: string;
  options: readonly SelectOption[];
  label: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <BuiPopover open={open} onOpenChange={setOpen}>
      <BuiPopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${current?.label ?? ""} ${label}`}
          aria-haspopup="listbox"
          className={cn(
            "flex h-7 max-w-36 cursor-pointer items-center justify-between gap-1 rounded-2lg border border-border-button-default bg-background-primary-default ps-2 pe-1.5 text-text-primary shadow-xs outline-none transition-[background-color,border-color] duration-200 hover:border-border-button-hover hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2",
            className,
          )}
        >
          <span className="truncate text-body-2-medium">{current?.label}</span>
          <RiArrowDownSLine aria-hidden className={cn("size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-200", open && "rotate-180")} />
        </button>
      </BuiPopoverTrigger>
      <BuiPopoverContent align="end" className="max-h-[240px] w-[174px] gap-1" role="listbox" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            onClick={() => { setOpen(false); if (option.value !== value) onChange(option.value); }}
            className={cn(
              "flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-2lg px-2 py-1.5 text-start text-body-2-medium text-text-primary outline-none transition-colors hover:bg-dropdown-item-hover-background focus-visible:bg-dropdown-item-hover-background",
              option.value === value && "bg-dropdown-item-hover-background",
            )}
          >
            <span className="truncate">{option.label}</span>
          </button>
        ))}
      </BuiPopoverContent>
    </BuiPopover>
  );
}

export function PreferencesCard({ bot, onPatch }: { bot: PreferencesBot; onPatch: (input: UpdateBotInput) => void }) {
  const { t, locale } = useT();
  const languages = useMemo<SelectOption[]>(() => {
    const names = typeof Intl !== "undefined" && "DisplayNames" in Intl
      ? new Intl.DisplayNames([locale], { type: "language" })
      : null;
    return BOT_REPLY_LANGUAGES.map((code) => ({
      value: code,
      label: code === "auto"
        ? t("boardui.autoDetect")
        : (names?.of(code) ?? code).replace(/^./, (letter) => letter.toUpperCase()),
    }));
  }, [locale, t]);
  return (
    <div className="flex w-full flex-col rounded-2xl bg-background-secondary-default px-3">
      <div className="flex min-h-14 items-center justify-between gap-3 py-3">
        <span className="flex items-center gap-2 text-body-medium text-text-primary">
          <RiGlobalLine aria-hidden className="size-5 shrink-0 text-foreground-icon-secondary" />
          {t("boardui.language")}
        </span>
        <BuiSelect
          value={bot.replyLanguage ?? "auto"}
          options={languages}
          label={t("boardui.agentLanguage")}
          onChange={(value) => onPatch({ replyLanguage: value as BotReplyLanguage })}
        />
      </div>
      {/* The finish notice is no longer chosen at creation: this is where it
          turns on. Absent on an older server, the row is not shown. */}
      {typeof bot.notifyOnFinish === "boolean" ? (
        <div className="flex min-h-14 items-center justify-between gap-3 border-t border-border-button-default py-3 dark:border-border-button-default/35">
          <label htmlFor={`agent-${bot.id}-notify`} className="flex cursor-pointer items-center gap-2 text-body-medium text-text-primary">
            <RiNotification3Line aria-hidden className="size-5 shrink-0 text-foreground-icon-secondary" />
            {t("boardui.notifyOnFinish")}
          </label>
          <Switch
            id={`agent-${bot.id}-notify`}
            checked={bot.notifyOnFinish}
            onCheckedChange={(notifyOnFinish) => onPatch({ notifyOnFinish })}
          />
        </div>
      ) : null}
    </div>
  );
}
