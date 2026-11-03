import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconCheck, IconPlus } from "@tabler/icons-react";
import { projectRosterSections } from "@openedbot/roster/domain/roster-sections";
import { cn, Dialog, Input } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import { useRosterSections } from "./dashboard/use-roster-sections";
import type { RosterDragRow } from "./dashboard/roster-drag";
import { BUTTON } from "./settings/primitives";

/**
 * « Déplacer vers… » : le pendant du glisser-déposer pour le doigt, et un
 * raccourci clavier pour la souris. Une ligne par section, la coche sur la
 * section courante, « Nouvelle section » en pied qui demande un nom. Sur
 * téléphone le `Dialog` est une feuille ancrée en bas : la voie iOS pour un
 * choix.
 */
export function MoveToSectionDialog({
  row,
  open,
  onClose,
}: {
  row: RosterDragRow;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: open });
  const { moveRow, createSectionWith } = useRosterSections();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const currentSectionId = row.kind === "bot" ? row.bot.sectionId : row.group.sectionId;
  const projection = projectRosterSections<RosterDragRow>({
    sections: roster.data?.sections ?? [],
    rows: [],
    sectionIdOf: (item) => (item.kind === "bot" ? item.bot.sectionId : item.group.sectionId),
  });

  const close = () => {
    onClose();
    setNaming(false);
    setName("");
  };
  const choose = (sectionId: string) => {
    close();
    if (sectionId !== currentSectionId) void moveRow(row, sectionId);
  };
  const create = () => {
    if (!name.trim()) return;
    close();
    void createSectionWith(row, name);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("appSidebar.moveToSectionTitle")}
      description={t("appSidebar.moveToSectionDescription")}
      closeLabel={t("common.close")}
      className="max-w-sm"
      footer={
        naming ? (
          <>
            <button type="button" onClick={() => setNaming(false)} className={BUTTON.secondary}>
              {t("common.cancel")}
            </button>
            <button type="button" onClick={create} disabled={!name.trim()} className={BUTTON.primary}>
              {t("groups.create")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setNaming(true)} className={BUTTON.secondary}>
            <IconPlus className="size-4" aria-hidden />
            {t("appSidebar.newSection")}
          </button>
        )
      }
    >
      {naming ? (
        <Input
          autoFocus
          value={name}
          maxLength={100}
          aria-label={t("appSidebar.sectionNameLabel")}
          placeholder={t("appSidebar.newSectionName")}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              create();
            }
          }}
        />
      ) : (
        <ul role="listbox" aria-label={t("appSidebar.moveToSectionTitle")} className="space-y-0.5">
          {projection.sections.map((section) => {
            const selected = section.id === currentSectionId;
            return (
              <li key={section.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(section.id)}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted",
                    selected && "font-medium",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {section.locked ? t("appSidebar.unassigned") : section.name}
                  </span>
                  {selected ? <IconCheck aria-hidden className="size-4 shrink-0 text-primary" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
