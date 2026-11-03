import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArchive } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import { partitionThreadVisibility } from "@/lib/thread/thread-visibility";
import { Badge, Dialog, cn, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { BotFace } from "../../../components/bot-face";
import { GroupFaceStack } from "../../../components/group-face-stack";
import {
  BUTTON,
  CardHeading,
  CardSkeleton,
  EmptyState,
  Note,
  SectionHeading,
  SettingsCard,
} from "../../../components/settings/primitives";
import { formatDate } from "../../../lib/format";
import { SettingsPane } from "../pane";

/**
 * L'action d'une ligne d'archive. `BUTTON.small` est calibré pour la souris ;
 * sous 768 px la même pilule remonte à 44 pt de haut : c'est la cible tactile
 * minimale du contrat PWA, et une archive se consulte surtout au pouce.
 */
const ROW_ACTION =
  "ohb-settings-action inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-md:min-h-11 max-md:px-3.5 max-md:text-sm";

/**
 * Les archives : la pièce où atterrit tout ce qu'on range.
 *
 * Avant, deux replis vivaient au bas de la barre latérale : « Archivés » et
 * « Masqués », chacun avec son chevron, sous la liste des conversations. Deux
 * disclosures pour des lignes qu'on ne consulte presque jamais, et qui
 * poussaient la liste vivante vers le haut : sur téléphone, elles occupaient la
 * zone du pouce. Elles sont ici, dans la roue crantée, là où vivent les autres
 * décisions durables.
 *
 * Une ligne d'archive n'est PAS une ligne de conversation grisée : c'est une
 * fiche de registre. Visage en sourdine, nom, et la date de rangement en
 * chiffres tabulaires : ce qu'on cherche dans une archive, c'est « quand
 * est-ce que je l'ai mis de côté ». Une seule action colorée par ligne :
 * remettre en circulation.
 */
export function ArchivesSettings() {
  const viewer = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const canPurge = viewer.data?.session.role !== "agency";
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    refetchInterval: (query) => query.state.data?.bots.some((bot) => bot.hostCleanupStatus === "pending" || bot.hostCleanupStatus === "verifying") ? 2000 : false,
  });
  const [deleting, setDeleting] = useState<BotDto | null>(null);

  // Une seule clé roster : archives, barre latérale et palette partagent le cache.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.roster });

  const restore = useMutation({
    mutationFn: (bot: BotDto) => api.updateBot(bot.id, { archived: false }),
    onSuccess: invalidate,
  });
  const reveal = useMutation({
    mutationFn: (threadId: string) => api.showThread(threadId),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (bot: BotDto) => api.purgeBot(bot.id),
    onSuccess: async (result) => {
      setDeleting(null);
      toast.success(t(result.hostCleanup === "queued" ? "botContextMenu.purgeQueued" : "botContextMenu.purgeDone"));
      await invalidate();
    },
  });
  const retryCleanup = useMutation({
    mutationFn: (botId: string) => api.retryBotHostCleanup(botId),
    onSuccess: invalidate,
  });

  const allBots = roster.data?.bots ?? [];
  const allGroups = roster.data?.groups ?? [];

  // L'archivage prime sur le masquage : un bot à la fois archivé et masqué
  // n'apparaît qu'une fois, dans la section qui décrit ce qui lui est arrivé
  // de plus fort. Et la corbeille prime sur l'archivage, pour la même raison :
  // « supprimé » est un fait plus fort que « rangé », même si le serveur pose
  // toujours les deux dates ensemble (invariant de la migration 0031).
  const trashedBots = useMemo(
    () => allBots.filter((bot) => bot.deletedAt != null),
    [allBots],
  );
  const archivedBots = useMemo(
    () => allBots.filter((bot) => bot.archivedAt !== null && bot.deletedAt == null),
    [allBots],
  );
  const hiddenBots = useMemo(
    () => partitionThreadVisibility(allBots).hidden.filter((bot) => bot.archivedAt === null),
    [allBots],
  );
  const hiddenGroups = useMemo(() => partitionThreadVisibility(allGroups).hidden, [allGroups]);

  const nothingStored =
    roster.isSuccess &&
    trashedBots.length === 0 &&
    archivedBots.length === 0 &&
    hiddenBots.length === 0 &&
    hiddenGroups.length === 0;

  if (roster.isPending) {
    return (
      <SettingsPane>
        <SectionHeading title={t("settingsArchives.title")} description={t("settingsArchives.description")} />
        <CardSkeleton label={t("common.loading")} />
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <SectionHeading
        title={t("settingsArchives.title")}
        description={t("settingsArchives.description")}
      />

      {roster.isError ? (
        <SettingsCard>
          <Note tone="danger" role="alert">{t("settingsArchives.loadFailed")}</Note>
          <div className="mt-3 flex justify-end">
            <button type="button" className={BUTTON.secondary} onClick={() => void roster.refetch()}>
              {t("settingsArchives.retry")}
            </button>
          </div>
        </SettingsCard>
      ) : null}

      {nothingStored ? (
        <EmptyState
          icon={<IconArchive aria-hidden stroke={1.5} />}
          title={t("settingsArchives.emptyTitle")}
          description={t("settingsArchives.emptyDescription")}
        />
      ) : null}

      {trashedBots.length > 0 ? (
        <SettingsCard padded={false} className={cn("overflow-hidden", isMobile ? "py-1" : "p-0")}>
          <div className={isMobile ? "px-4 pt-3 pb-1" : "px-4 pt-4"}>
            <CardHeading
              title={t("settingsArchives.trashTitle")}
              description={t("settingsArchives.trashDescription")}
            />
          </div>
          <ul className={cn("mt-1", isMobile ? "divide-y divide-border/40" : "divide-y divide-border")}>
            {trashedBots.map((bot) => (
              <StoredRow
                key={bot.id}
                avatar={
                  <BotFace
                    name={bot.name}
                    seed={bot.id}
                    face={bot.face}
                    className="size-9 opacity-60"
                  />
                }
                title={bot.name}
                meta={t("settingsArchives.deletedOn", { date: formatDate(bot.deletedAt, locale) })}
                status={
                  <>
                    {bot.hostCleanupStatus === "pending" ? <span className="block text-muted-foreground">{t("botHostCleanup.pending")}</span> : null}
                    {bot.hostCleanupStatus === "verifying" ? <span className="block text-muted-foreground">{t("botHostCleanup.verifying")}</span> : null}
                    {bot.hostCleanupStatus === "failed" ? <span className="block text-muted-foreground">{t("botHostCleanup.failed")}</span> : null}
                  </>
                }
                actions={
                  <>
                    {bot.hostCleanupStatus === "failed" ? (
                      <button type="button" className={BUTTON.small} disabled={retryCleanup.isPending} onClick={() => retryCleanup.mutate(bot.id)}>
                        {retryCleanup.isPending && retryCleanup.variables === bot.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                        {t("botHostCleanup.retry")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={ROW_ACTION}
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(bot)}
                    >
                      {restore.isPending && restore.variables?.id === bot.id
                        ? t("settingsArchives.restoring")
                        : t("settingsArchives.restore")}
                    </button>
                    <button
                      type="button"
                      className={cn(ROW_ACTION, "border-destructive/40 text-destructive-text hover:bg-neg-soft")}
                      disabled={!canPurge}
                      title={!canPurge ? t("fleet.disabledAction") : undefined}
                      onClick={() => { if (canPurge) { remove.reset(); setDeleting(bot); } }}
                    >
                      {t("settingsArchives.delete")}
                    </button>
                  </>
                }
              />
            ))}
          </ul>
        </SettingsCard>
      ) : null}

      {archivedBots.length > 0 ? (
        <SettingsCard padded={false} className={cn("overflow-hidden", isMobile ? "py-1" : "p-0")}>
          <div className={isMobile ? "px-4 pt-3 pb-1" : "px-4 pt-4"}>
            <CardHeading
              title={t("settingsArchives.botsTitle")}
              description={t("settingsArchives.botsDescription")}
            />
          </div>
          <ul className={cn("mt-1", isMobile ? "divide-y divide-border/40" : "divide-y divide-border")}>
            {archivedBots.map((bot) => (
              <StoredRow
                key={bot.id}
                avatar={
                  <BotFace
                    name={bot.name}
                    seed={bot.id}
                    face={bot.face}
                    className="size-9 opacity-75"
                  />
                }
                title={bot.name}
                meta={t("settingsArchives.archivedOn", {
                  date: formatDate(bot.archivedAt, locale),
                })}
                actions={
                  <>
                    <button
                      type="button"
                      className={ROW_ACTION}
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(bot)}
                    >
                      {restore.isPending && restore.variables?.id === bot.id
                        ? t("settingsArchives.restoring")
                        : t("settingsArchives.restore")}
                    </button>
                    <button
                      type="button"
                      className={cn(ROW_ACTION, "border-destructive/40 text-destructive-text hover:bg-neg-soft")}
                      disabled={!canPurge}
                      title={!canPurge ? t("fleet.disabledAction") : undefined}
                      onClick={() => { if (canPurge) { remove.reset(); setDeleting(bot); } }}
                    >
                      {t("settingsArchives.delete")}
                    </button>
                  </>
                }
              />
            ))}
          </ul>
        </SettingsCard>
      ) : null}

      {hiddenBots.length > 0 || hiddenGroups.length > 0 ? (
        <SettingsCard padded={false} className={cn("overflow-hidden", isMobile ? "py-1" : "p-0")}>
          <div className={isMobile ? "px-4 pt-3 pb-1" : "px-4 pt-4"}>
            <CardHeading
              title={t("settingsArchives.hiddenTitle")}
              description={t("settingsArchives.hiddenDescription")}
            />
          </div>
          <ul className={cn("mt-1", isMobile ? "divide-y divide-border/40" : "divide-y divide-border")}>
            {hiddenBots.map((bot) => (
              <StoredRow
                key={bot.id}
                avatar={
                  <BotFace
                    name={bot.name}
                    seed={bot.id}
                    face={bot.face}
                    className="size-9 opacity-75"
                  />
                }
                title={bot.name}
                meta={t("settingsArchives.activeOn", {
                  date: formatDate(bot.lastActivityAt, locale),
                })}
                actions={
                  <button
                    type="button"
                    className={ROW_ACTION}
                    disabled={reveal.isPending}
                    onClick={() => reveal.mutate(bot.threadId)}
                  >
                    {reveal.isPending && reveal.variables === bot.threadId
                      ? t("settingsArchives.showing")
                      : t("settingsArchives.show")}
                  </button>
                }
              />
            ))}
            {hiddenGroups.map((group: GroupDto) => (
              <StoredRow
                key={group.id}
                avatar={
                  <GroupFaceStack
                    members={group.members}
                    size="size-5"
                    className="size-9 justify-center opacity-75"
                  />
                }
                title={group.name}
                badge={<Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">{t("settingsArchives.room")}</Badge>}
                meta={t("settingsArchives.activeOn", {
                  date: formatDate(group.lastActivityAt, locale),
                })}
                actions={
                  <button
                    type="button"
                    className={ROW_ACTION}
                    disabled={reveal.isPending}
                    onClick={() => reveal.mutate(group.threadId)}
                  >
                    {reveal.isPending && reveal.variables === group.threadId
                      ? t("settingsArchives.showing")
                      : t("settingsArchives.show")}
                  </button>
                }
              />
            ))}
          </ul>
        </SettingsCard>
      ) : null}

      {deleting ? (
        <Dialog
          open
          onClose={() => { if (!remove.isPending) setDeleting(null); }}
          role="alertdialog"
          title={t("botContextMenu.purgeTitle", { name: deleting.name })}
          description={t("botContextMenu.purgeDescription")}
          closeLabel={t("common.close")}
          footer={
            <>
              <button
                type="button"
                className={BUTTON.secondary}
                disabled={remove.isPending}
                onClick={() => setDeleting(null)}
              >
                {t("common.cancel")}
              </button>
              {/* Le second geste n'existe qu'après un refus du runtime : tant
                  qu'on n'a pas essayé, « supprimer chez openedbot seul » n'est pas
                  une option à offrir : ce serait apprendre à la contourner. */}
              <button
                type="button"
                className={BUTTON.danger}
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleting)}
              >
                {remove.isPending ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
                ) : null}
                {remove.isPending
                  ? t("botContextMenu.purging")
                  : t("botContextMenu.purgeConfirm")}
              </button>
            </>
          }
        >
          {remove.isError ? <p className="text-destructive-text">{t("botContextMenu.deleteError", { message: remove.error.message })}</p> : null}
        </Dialog>
      ) : null}
    </SettingsPane>
  );
}

/**
 * Une fiche de registre : visage en sourdine, nom, date de rangement, et les
 * actions à droite. Les actions passent à la ligne sous le nom en dessous de
 * 30rem : sur un téléphone étroit, un nom long et deux boutons ne tiennent pas
 * côte à côte sans rogner l'un des deux sous la cible de 44 pt.
 */
function StoredRow({
  avatar,
  title,
  badge,
  meta,
  status,
  actions,
}: {
  avatar: ReactNode;
  title: string;
  badge?: ReactNode;
  meta: string;
  status?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="shrink-0">{avatar}</span>
      <span className="grid min-w-[8rem] flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {badge}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-xs tabular-nums text-muted-foreground">{meta}</span>
          {status}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">{actions}</span>
    </li>
  );
}
