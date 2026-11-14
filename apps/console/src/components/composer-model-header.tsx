import { RiSparkling2Fill } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";
import { ProviderIcon } from "./provider-icon";

/** In the top pill, the bare mark in its brand colour, as in the picker. */
const PROVIDER_GLYPH_HEADER = "rounded-none bg-transparent";

/**
 * The content of the top bar's « modèle » pill: an icon alone, with no
 * tooltip (operator request of 08-11-2026); the model name and the effort
 * live in the trigger's aria-label.
 * The mark of the provider that answers (the fallback's, otherwise the chosen
 * model's); with no known provider, the generic spark. A fallback sets an alert
 * dot on the icon.
 */
export function ModelHeaderGlyph({ provider, warn, fallback }: { provider: string | null; warn: boolean; fallback: boolean }) {
  return (
    <span className="relative flex">
      {provider ? (
        <ProviderIcon provider={provider} decorative withTitle={false} colored className={cn("size-4 shrink-0 [&>svg]:size-4", PROVIDER_GLYPH_HEADER)} />
      ) : (
        <RiSparkling2Fill aria-hidden className={cn("size-3.5 shrink-0", warn ? "text-warn-700" : "text-foreground-icon-secondary")} />
      )}
      {fallback ? <span data-model-fallback="" aria-hidden className="absolute -end-1 -top-1 size-1.5 rounded-full bg-warn-700" /> : null}
    </span>
  );
}

