import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ContextMenu } from "radix-ui";
import { ChevronRight, ArrowDown, ArrowUp, Pencil, Pin, Trash2 } from "lucide-react";
import type { RosterSectionMoveState, RosterSectionProjection } from "@openedbot/roster/domain/roster-sections";
import { Button, cn, Dialog, Tooltip, TooltipContent, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { PINNED_DROP_ID, useRosterDrag } from "./roster-drag";

const MENU_ITEM =
  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50";

/**
 * L'en-tête d'une section du roster, le `Zbe` de Grok Bot : le nom, le
 * compte quand elle est repliée, un chevron qui tourne. Un clic replie ; un
 * clic droit (ou la touche Menu) offre renommer, monter, descendre,
 * supprimer. La section par défaut (« Non assigné ») n'a ni menu ni
 * renommage : elle se replie, et c'est tout.
 *
 * Toute la section (en-tête et corps) est une cible de dépôt
 * (`data-drop-section`) : c'est l'appelant qui pose l'attribut sur le
 * conteneur, l'en-tête ne fait que refléter le survol.
 */
export function RosterSectionHeader<Row>({
  section,
  label,
  moveState,
  renaming,
  onRenamingChange,
  onToggle,
  onRename,
  onMove,
  onDelete,
  canManage,
}: {
  section: RosterSectionProjection<Row>;
  label: string;
  moveState: RosterSectionMoveState;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  onToggle: () => void;
  onRename: (name: string) => void;
  onMove: (position: number) => void;
  onDelete: () => void;
  canManage: boolean;
}) {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  const [confirming, setConfirming] = useState(false);
  const over = dragging?.over === section.id;

  // Un champ dans un bouton n'est pas du HTML valide, et Chrome ne lui
  // livre pas le clavier : en renommage, l'en-tête devient un simple bloc.
  if (renaming) {
    return (
      <div className="flex h-8 w-full min-w-0 items-center gap-1.5 px-2">
        <SectionNameEditor
          initialValue={section.name}
          ariaLabel={t("appSidebar.sectionNameLabel")}
          onCommit={(name) => {
            onRenamingChange(false);
            if (name.trim() && name.trim() !== section.name) onRename(name);
          }}
          onCancel={() => onRenamingChange(false)}
        />
      </div>
    );
  }

  // Deux gris, jamais le même : le survol de l'en-tête reste plus clair que
  // la ligne active (`bg-sidebar-accent`) juste dessous, sinon les deux se
  // lisent comme un seul bloc. Le tooltip dit ce que fait le clic : le
  // chevron seul ne suffisait pas à le deviner.
  const button = (
    <button
      type="button"
      aria-expanded={!section.collapsed}
      onClick={onToggle}
      className={cn(
        "mb-1 flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-foreground/[0.06] hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        over && "text-sidebar-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-left" title={label}>{label}</span>
      {section.collapsed ? <span className="tabular-nums">{section.rows.length}</span> : null}
      <ChevronRight
        aria-hidden
        className={cn("size-3.5 shrink-0 transition-transform", !section.collapsed && "rotate-90")}
      />
    </button>
  );
  // Les deux déclencheurs Radix (tooltip, menu contextuel) fusionnent leurs
  // props sur le MÊME bouton DOM : un `Tooltip.Root` intercalé entre eux
  // n'est pas un élément, et le menu perdait son écouteur `contextmenu`.
  const withTooltip = (trigger: ReactNode) => (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {t(section.collapsed ? "appSidebar.expandSection" : "appSidebar.collapseSection")}
      </TooltipContent>
    </Tooltip>
  );

  if (section.locked || !canManage) return withTooltip(button);

  return (
    <>
      <ContextMenu.Root>
        {withTooltip(<ContextMenu.Trigger asChild>{button}</ContextMenu.Trigger>)}
        <ContextMenu.Portal>
          <ContextMenu.Content
            aria-label={t("appSidebar.sectionMenuLabel")}
            className="z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => onRenamingChange(true)}>
              <Pencil className="size-4" />
              {t("appSidebar.renameSection")}
            </ContextMenu.Item>
            <ContextMenu.Item
              className={MENU_ITEM}
              disabled={!moveState.canMoveUp}
              onSelect={() => moveState.upPosition !== null && onMove(moveState.upPosition)}
            >
              <ArrowUp className="size-4" />
              {t("appSidebar.moveSectionUp")}
            </ContextMenu.Item>
            <ContextMenu.Item
              className={MENU_ITEM}
              disabled={!moveState.canMoveDown}
              onSelect={() => moveState.downPosition !== null && onMove(moveState.downPosition)}
            >
              <ArrowDown className="size-4" />
              {t("appSidebar.moveSectionDown")}
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-border" />
            <ContextMenu.Item
              className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive-text outline-none data-[highlighted]:bg-destructive/10"
              onSelect={() => setConfirming(true)}
            >
              <Trash2 className="size-4" />
              {t("appSidebar.deleteSection")}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        title={t("appSidebar.deleteSectionTitle", { name: section.name })}
        description={t("appSidebar.deleteSectionDescription")}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              {t("appSidebar.deleteSection")}
            </Button>
          </>
        }
      />
    </>
  );
}

/**
 * Le renommage en place : Entrée valide, Échap annule, la perte du focus
 * valide aussi (c'est ce qu'on attend d'un champ de nom dans une liste).
 */
function SectionNameEditor({
  initialValue,
  ariaLabel,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(draft);
    else onCancel();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };
  return (
    <input
      ref={inputRef}
      aria-label={ariaLabel}
      value={draft}
      maxLength={100}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

/**
 * La zone « Faire glisser pour épingler » : elle n'existe que pendant un
 * drag, SOUS la recherche, dans le flux de l'en-tête, comme chez Grok Bot.
 * Posée par-dessus le champ (32 px), c'était une cible trop maigre pour
 * être visée et son libellé touchait la bordure : décision opérateur, elle
 * prend une vraie hauteur (104 px) quitte à pousser les sections pendant le
 * drag. Elle couvre toute la largeur de l'en-tête, bouton « + » compris :
 * alignée sur le seul champ, elle paraissait tronquée à droite. Quand il y
 * a des épinglés, l'appelant ne la rend pas : leurs tuiles s'écartent pour
 * faire la place de la ligne prise, et ce sont elles la cible.
 */
export function RosterPinDropZone() {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  if (!dragging) return null;
  const over = dragging.over === PINNED_DROP_ID;
  return (
    <div
      data-drop-section={PINNED_DROP_ID}
      className={cn(
        "relative flex h-26 items-center justify-center gap-2 rounded-lg border-2 border-dashed border-sidebar-border px-3 text-center text-sm text-sidebar-muted-foreground transition-colors group-data-[collapsible=icon]:hidden",
        over && "border-primary text-sidebar-foreground",
      )}
    >
      {over ? <span aria-hidden className="absolute inset-0 rounded-md bg-primary/10" /> : null}
      <Pin aria-hidden className="relative size-4 shrink-0" />
      <span className="relative">{t("appSidebar.dropToPin")}</span>
    </div>
  );
}

/**
 * Le trait d'insertion : là où la ligne prise se posera. Rendu au-dessus de
 * la ligne d'index `index` ; `index === rows.length` désigne la fin de la
 * section (rendu après la dernière ligne).
 */
export function RosterInsertionLine({ sectionId, index, quiet = false }: { sectionId: string; index: number; quiet?: boolean }) {
  const { dragging } = useRosterDrag();
  const slot = dragging?.slot;
  // `quiet` : le créneau est la place actuelle de la ligne prise : la
  // déposer là ne changerait rien, le trait ne dirait qu'un faux mouvement.
  if (quiet || !slot || slot.sectionId !== sectionId || slot.index !== index) return null;
  return <span aria-hidden className="pointer-events-none absolute inset-x-2 -top-0.5 z-10 h-0.5 rounded-full bg-primary" />;
}

/** Le corps d'une section vide : cible de dépôt, « Non assigné » compris. */
export function RosterEmptySectionBody() {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  return (
    <p className={cn("px-2 py-2 text-xs text-sidebar-muted-foreground", dragging && "min-h-12")}>
      {t("appSidebar.emptySection")}
    </p>
  );
}
