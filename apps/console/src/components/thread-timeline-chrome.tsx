import { useT } from "../lib/i18n";

/**
 * La puce de date du template : « Aujourd'hui », « Hier », puis la date,
 * suivis de l'heure du premier message qu'elle ouvre (« Hier 16:41 »).
 */
export function DateChip({ iso }: { iso: string }) {
  const { t, formatDate } = useT();
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day = date.toDateString() === today.toDateString()
    ? t("boardui.today")
    : date.toDateString() === yesterday.toDateString()
      ? t("boardui.yesterday")
      : formatDate(iso, { dateStyle: "medium" });
  const label = `${day} ${formatDate(iso, { timeStyle: "short" })}`;
  return (
    <div className="mt-3 mb-1 flex justify-center" data-thread-date="">
      <time dateTime={iso} className="bui-date-chip">{label}</time>
    </div>
  );
}

/** Un repère centré : « Routine créée », « Mission annulée »… */
export function Divider({ children, findTargetId, findActive = false }: {
  children: React.ReactNode;
  findTargetId?: string;
  findActive?: boolean;
}) {
  return (
    <p
      data-thread-find-target={findTargetId}
      className={`self-center rounded-full px-3 py-1 text-center text-body-2-medium text-text-tertiary ${findActive ? "ring-2 ring-border-focus-ring ring-offset-2" : ""}`}
    >
      {children}
    </p>
  );
}
