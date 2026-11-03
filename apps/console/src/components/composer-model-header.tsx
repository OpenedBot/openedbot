import type { ReactElement } from "react";
import { RiSparkling2Fill } from "@remixicon/react";
import { cn, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { ProviderIcon } from "./provider-icon";

/** Dans la pilule du haut, la marque se lit : plus marquée que dans les listes. */
const PROVIDER_GLYPH_HEADER = "rounded-none bg-transparent text-text-primary/70";

/**
 * Le contenu de la pilule « modèle » de la barre du haut : une icône seule, le
 * nom du modèle et l'effort vivent dans l'infobulle (`ModelHeaderTooltip`).
 * La marque du fournisseur qui répond (celui du repli, sinon celui du modèle
 * choisi) ; sans fournisseur connu, l'étoile générique. Un repli pose un point
 * d'alerte sur l'icône.
 */
export function ModelHeaderGlyph({ provider, warn, fallback }: { provider: string | null; warn: boolean; fallback: boolean }) {
  return (
    <span className="relative flex">
      {provider ? (
        <ProviderIcon provider={provider} decorative withTitle={false} className={cn("size-4 shrink-0 [&>svg]:size-4", PROVIDER_GLYPH_HEADER)} />
      ) : (
        <RiSparkling2Fill aria-hidden className={cn("size-3.5 shrink-0", warn ? "text-warn-700" : "text-foreground-icon-secondary")} />
      )}
      {fallback ? <span data-model-fallback="" aria-hidden className="absolute -end-1 -top-1 size-1.5 rounded-full bg-warn-700" /> : null}
    </span>
  );
}

/** L'infobulle de la pilule : « modèle · effort » (l'effort est absent sur un repli). */
export function ModelHeaderTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
