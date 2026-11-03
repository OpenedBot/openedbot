import { cn } from "@openedbot/browser-ui-kit";
import { useT, type MessageKey } from "../../lib/i18n";
import { ACCOUNT_LAYOUTS, setAccountLayout, useAccountLayout, type AccountLayout } from "../../lib/shell/account-layout";

const LAYOUT_COPY: Record<AccountLayout, { name: MessageKey; hint: MessageKey }> = {
  base: { name: "settings.appearance.layouts.base.name", hint: "settings.appearance.layouts.base.hint" },
  a: { name: "settings.appearance.layouts.a.name", hint: "settings.appearance.layouts.a.hint" },
  b: { name: "settings.appearance.layouts.b.name", hint: "settings.appearance.layouts.b.hint" },
  c: { name: "settings.appearance.layouts.c.name", hint: "settings.appearance.layouts.c.hint" },
};

/** La maquette d'une disposition : cadre, barre latérale, en-tête, et le compte en couleur d'accent. */
function LayoutThumb({ layout, className }: { layout: AccountLayout; className?: string }) {
  const rail = layout === "c";
  const sidebarX = rail ? 7 : 0;
  const mainX = sidebarX + 17;
  const marker: Record<AccountLayout, { x: number; y: number }> = {
    base: { x: 8.5, y: 34 },
    a: { x: 55, y: 4 },
    b: { x: 5.5, y: 4.5 },
    c: { x: 3.5, y: 35 },
  };
  const { x, y } = marker[layout];
  return (
    <svg viewBox="0 0 60 40" aria-hidden className={cn("shrink-0 overflow-visible", className)}>
      <rect x="0.5" y="0.5" width="59" height="39" rx="5" className="fill-background-primary-default stroke-border-button-default" />
      {rail ? <path d="M5.5 0.5H7v39H5.5A5 5 0 0 1 0.5 34.5v-29a5 5 0 0 1 5-5Z" className="fill-background-tertiary-default" /> : null}
      <path
        d={rail ? `M${sidebarX} 0.5h17v39H${sidebarX}Z` : "M5.5 0.5H17v39H5.5a5 5 0 0 1-5-5v-29a5 5 0 0 1 5-5Z"}
        className="fill-background-secondary-default"
      />
      <line x1={mainX} y1="8" x2="59.5" y2="8" className="stroke-border-button-default" />
      {[14, 19, 24].map((row) => (
        <line key={row} x1={sidebarX + 3} y1={row} x2={sidebarX + 13} y2={row} strokeLinecap="round" strokeWidth="1.5" className="stroke-border-button-default" />
      ))}
      <rect x={mainX + 6} y="28" width={60 - mainX - 12} height="6" rx="3" className="fill-background-secondary-default" />
      <circle cx={x} cy={y} r="2.6" className="fill-accent-500" />
    </svg>
  );
}

/** Choix de la disposition du cadre (bureau). Appliqué immédiatement, stocké dans ce navigateur. */
export function AccountLayoutPicker() {
  const { t } = useT();
  const layout = useAccountLayout();
  return (
    <div role="radiogroup" aria-label={t("settings.appearance.layoutTitle")} className="mt-4 grid grid-cols-2 gap-2">
      {ACCOUNT_LAYOUTS.map((option) => {
        const checked = option === layout;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            data-account-layout-choice={option}
            onClick={() => setAccountLayout(option)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-3 rounded-[12px] border p-2 text-start outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              checked ? "border-input bg-accent" : "border-border hover:bg-accent/50",
            )}
          >
            <LayoutThumb layout={option} className="h-10 w-[60px]" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{t(LAYOUT_COPY[option].name)}</span>
              <span className="text-xs leading-4 text-muted-foreground">{t(LAYOUT_COPY[option].hint)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
