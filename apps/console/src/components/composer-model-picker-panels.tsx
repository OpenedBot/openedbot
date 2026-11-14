import type { ReactNode } from "react";
import { RiFlashlightFill } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";
import { ProviderIcon, providerLabel } from "./provider-icon";
import { BUTTON } from "./settings/primitives";
import { useT } from "../lib/i18n";
import { useOpenSettings } from "../lib/shell/settings-overlay";

/** The provider heading of the model list, and the panel of a provider not connected yet. */

export function ProviderHeading({ provider, name }: { provider: string; name: string }) {
  return (
    <p className="shrink-0 truncate px-2 pt-1 text-caption-1-regular text-text-tertiary">
      {providerLabel(provider, name)}
    </p>
  );
}

export function ProviderNotConnectedPanel({ provider, name, onClose }: {
  provider: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const openSettings = useOpenSettings();

  return (
    <div className="flex flex-col items-start gap-3 px-2 py-3">
      <p className="text-body-2-medium text-text-secondary">
        {t("composer.providerNotConnected", { provider: providerLabel(provider, name) })}
      </p>
      <button
        type="button"
        className={BUTTON.secondary}
        onClick={() => {
          onClose();
          openSettings("/settings/models");
        }}
      >
        {t("composer.providerConnectCta")}
      </button>
    </div>
  );
}

/** The bare glyph: no pill, its brand colour (`ProviderIcon colored`). */
export const PROVIDER_GLYPH = "rounded-none bg-transparent";

/** A model row of the picker: its glyph, its name, the effort chip, the radio. */
export function ModelRadio({
  label,
  detail,
  provider,
  checked,
  disabled,
  onSelect,
  trailing,
  fastAvailable = false,
  tall = false,
}: {
  label: string;
  detail?: string;
  /** The provider: its 16 px glyph precedes the name, as in the template. */
  provider?: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  /** A 44 pt row in the mobile sheet. Desktop keeps its 36 px. */
  tall?: boolean;
  /** The chosen model's effort chip. */
  trailing?: ReactNode;
  /**
   * The model offers a fast mode: an unchecked row carries a faint bolt, so
   * it can be found before picking. The checked row says it in its chip.
   */
  fastAvailable?: boolean;
}) {
  const { t } = useT();
  return (
    <div
      className={cn(
        "openedbot-row relative flex w-full shrink-0 items-center rounded-2lg px-2",
        tall ? "min-h-11 active:bg-background-primary-hover" : "h-9",
        checked ? "bg-background-primary-hover" : "hover:bg-background-primary-hover",
        disabled && "opacity-50",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={detail ? `${label} ${detail}` : label}
        title={detail ? `${label} ${detail}` : label}
        disabled={disabled}
        onClick={onSelect}
        className="absolute inset-0 cursor-pointer rounded-2lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring disabled:cursor-not-allowed"
      />
      <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {provider ? <ProviderIcon provider={provider} decorative colored={!tall} className={cn("size-4 shrink-0", !tall && PROVIDER_GLYPH)} /> : null}
          <span className="min-w-0 flex-1 truncate text-body-medium whitespace-nowrap">
            <span className="text-text-primary">{label}</span>
            {detail ? <span className="ms-1.5 text-text-tertiary">{detail}</span> : null}
          </span>
          {!checked && fastAvailable ? (
            <span title={t("composer.modelFastAvailable")} className="pointer-events-auto flex shrink-0">
              <RiFlashlightFill aria-hidden className="size-3.5 text-foreground-icon-quaternary" />
              <span className="sr-only">{t("composer.modelFastAvailable")}</span>
            </span>
          ) : null}
          {trailing ? <span className="pointer-events-auto flex shrink-0">{trailing}</span> : null}
        </span>
        <span aria-hidden className="relative flex size-3.5 shrink-0 items-center justify-center rounded-full">
          <span
            className={cn(
              "absolute inset-0 rounded-full border-[0.875px] border-border-button-hover bg-background-primary-default shadow-xs transition-opacity duration-200",
              checked && "opacity-0",
            )}
          />
          <span
            className={cn(
              "absolute inset-0 rounded-full bg-gradient-to-b from-accent-500 to-accent-600 shadow-[inset_0px_0px_0px_0.875px_var(--color-accent-500),inset_0px_1.75px_0px_0px_rgba(255,255,255,0.25)] transition-opacity duration-200",
              !checked && "opacity-0",
            )}
          />
          <span
            className={cn(
              "absolute top-1/2 left-1/2 size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-control-indicator-background transition-[scale,opacity] duration-200",
              checked ? "scale-100 opacity-100" : "scale-0 opacity-0",
            )}
          />
        </span>
      </span>
    </div>
  );
}
