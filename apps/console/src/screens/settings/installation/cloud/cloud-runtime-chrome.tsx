import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { IconHelp } from "@tabler/icons-react";
import { cn, Popover, Skeleton, useIsMobile } from "@openedbot/browser-ui-kit";
import { useT } from "../../../../lib/i18n";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import { MobileSegmented } from "../../../../components/mobile/inset-grouped";
import { ACTIONS, SettingsCard } from "../../../../components/settings/primitives";
import { type RuntimeSection } from "./cloud-shared";

/**
 * The runtime screen's silhouette while the configuration is read:
 * the title and its sentence, the link card (name, two ends joined, the
 * button row), then the section rail: the exact geometry of
 * `RuntimeConnectionForm`.
 */
export function RuntimeFormSkeleton() {
  return (
    <div role="status" aria-label="Chargement du runtime…" className="flex flex-col gap-8">
      <div className="space-y-2">
        <Skeleton className="h-5 w-40 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-full max-w-[60ch] motion-reduce:animate-none" />
      </div>
      <SettingsCard className="space-y-5">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48 motion-reduce:animate-none" />
          <Skeleton className="h-4 w-full max-w-[40ch] motion-reduce:animate-none" />
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-5">
          <Skeleton className="size-11 rounded-xl motion-reduce:animate-none" />
          <Skeleton className="h-0.5 w-full motion-reduce:animate-none" />
          <Skeleton className="size-11 rounded-xl motion-reduce:animate-none" />
        </div>
        <div className={ACTIONS}>
          <Skeleton className="h-9 w-40 rounded-md motion-reduce:animate-none" />
          <Skeleton className="h-9 w-24 rounded-md motion-reduce:animate-none" />
        </div>
      </SettingsCard>
      <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
        <div className="space-y-1">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-9 w-full rounded-lg motion-reduce:animate-none" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-xl motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/**
 * Who the runtime belongs to, and what openedbot allows itself on it: at the header's « ? »,
 * not in a banner.
 *
 * It is a CONTRACT reminder: it does not change from one visit to the next, and it
 * asks for nothing. At full width under the cards it pushed down, every time,
 * the facts that do move (the link, the last test, the last error).
 * At the « ? » it stays one gesture away, where one goes to look up "why this
 * screen does not offer me X".
 *
 * The text itself is not invented: if the host offers the operator
 * (`provider_management`, over the outgoing link), provider access is set
 * from this interface; otherwise the gesture stays on the host. In both cases
 * openedbot opens no session toward the client's machine.
 */
export function RuntimeOwnershipHelp({ runtime }: { runtime: RuntimePublicDto | null }) {
  const { t } = useT();
  const body = runtime?.management.kind === "host" ? (
    <>
      <p className="text-sm font-semibold text-foreground">Ce runtime vous appartient</p>
      <p>{t("cloudRuntimeSettings.linkManagedProviders")}</p>
    </>
  ) : (
    <>
      <p className="text-sm font-semibold text-foreground">Ce runtime vous appartient</p>
      <p>openedbot ne l’administre pas et n’ouvre aucune session sur votre machine. Posez vos clés fournisseur depuis votre hôte :</p>
      <code className="block rounded-lg bg-surface-sunken px-2 py-1.5 font-mono text-[11px] break-all text-foreground">
        edge-setup credentials add &lt;fournisseur&gt;
      </code>
    </>
  );
  return (
    <Popover
      align="end"
      width={320}
      trigger={({ ref, onClick, "aria-expanded": expanded }) => (
        <button
          ref={ref as (el: HTMLButtonElement | null) => void}
          type="button"
          onClick={onClick}
          aria-expanded={expanded}
          aria-label="À propos de ce runtime"
          title="À propos de ce runtime"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <IconHelp className="size-4" />
        </button>
      )}
    >
      <div className="space-y-2 p-3.5 text-xs leading-5 text-muted-foreground">{body}</div>
    </Popover>
  );
}

/**
 * The section rail: vertical on the left on desktop, a segmented control on
 * the phone. One tab, one panel; `?section=` shares it and reloads it.
 */
const RUNTIME_RAIL_ITEM =
  "flex min-h-9 shrink-0 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

export function RuntimeSectionRail({
  sections,
  current,
  onChange,
  children,
}: {
  sections: ReadonlyArray<{ id: RuntimeSection; label: string; count?: number }>;
  current: RuntimeSection;
  onChange: (section: RuntimeSection) => void;
  children: ReactNode;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const panelId = "runtime-section-panel";
  const agentsLink = (
    <Link
      to="/settings/agents"
      className={cn(RUNTIME_RAIL_ITEM, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
    >
      {t("settingsSidebar.agents")}
    </Link>
  );
  if (isMobile) {
    return (
      <>
        <div data-inset-grouped="">
          <MobileSegmented
            value={current}
            onChange={onChange}
            segments={sections.map((section) => ({
              id: section.id,
              label: section.label,
              count: section.count === undefined ? null : String(section.count),
            }))}
            label="Sections du runtime"
            controls={panelId}
            idPrefix="runtime-section"
          />
        </div>
        <div className="px-4">{agentsLink}</div>
        <div id={panelId} role="tabpanel" aria-labelledby={`runtime-section-${current}`} className="flex flex-col gap-2">
          {children}
        </div>
      </>
    );
  }
  return (
    <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-start">
      <nav className="scrollbar-subtle flex gap-1 overflow-x-auto lg:sticky lg:top-0 lg:flex-col">
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label="Sections du runtime"
          className="flex gap-1 lg:flex-col"
        >
          {sections.map((section) => {
            const selected = section.id === current;
            return (
              <button
                key={section.id}
                type="button"
                role="tab"
                id={`runtime-section-${section.id}`}
                aria-selected={selected}
                aria-controls={panelId}
                onClick={() => onChange(section.id)}
                className={cn(
                  RUNTIME_RAIL_ITEM,
                  selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span>{section.label}</span>
                {section.count !== undefined ? (
                  <span className="rounded-md bg-surface-sunken px-1.5 text-xs tabular-nums text-muted-foreground">{section.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        {agentsLink}
      </nav>
      <div id={panelId} role="tabpanel" aria-labelledby={`runtime-section-${current}`} className="flex min-w-0 flex-col gap-4">
        {children}
      </div>
    </div>
  );
}
