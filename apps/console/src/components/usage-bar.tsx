import { cn } from "@openedbot/browser-ui-kit";

/**
 * Jauge de consommation d'un fournisseur mesuré.
 *
 * La teinte porte l'information : graphite au repos, ambre puis rouge quand le
 * mur approche ; le bleu de marque reste réservé aux actions. Une consommation
 * qui ne se lit pas n'a pas de jauge du tout : une piste vide se lirait
 * « zéro consommé », et un filet pointillé se lit comme un séparateur.
 */
export function UsageBar({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  const safe = Math.max(0, Math.min(100, value));
  const tone = safe > 95 ? "bg-destructive" : safe > 80 ? "bg-amber-500" : "bg-foreground/70";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(safe)}
      aria-valuetext={label}
      className={cn("h-1.5 min-w-0 overflow-hidden rounded-full bg-foreground/10", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", tone)}
        style={{ width: `${safe}%` }}
      />
    </div>
  );
}
