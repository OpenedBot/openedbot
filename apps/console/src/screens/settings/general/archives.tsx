import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArchive } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import { partitionThreadVisibility } from "@/lib/thread/thread-visibility";
import { Badge, Dialog, cn, toast } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { BotFace } from "../../../components/bot-face";
import { GroupFaceStack } from "../../../components/group-face-stack";
import {
  BUTTON,
  CardSkeleton,
  EmptyState,
  Note,
  SectionHeading,
  SettingsCard,
} from "../../../components/settings/primitives";
import { formatDate } from "../../../lib/format";
import { SettingsPane } from "../pane";
import { ArchiveSection } from "./archive-section";

/**
 * Les actions d'une ligne d'archive : les pilules des autres réglages
 * (`BUTTON`, comme « Vérifier le lien » et « Retirer » du Runtime), voile
 * neutre pour remettre en circulation, rouge plein pour effacer. Sous 768 px
 * la pilule remonte à 44 pt de haut : c'est la cible tactile minimale du
 * contrat PWA, et une archive se consulte surtout au pouce.
 */
const ROW_TOUCH = "max-md:h-11 max-md:px-3.5";
const ROW_ACTION = cn(BUTTON.secondary, ROW_TOUCH);
const ROW_DANGER = cn(BUTTON.danger, ROW_TOUCH);

/** Une conversation masquée : celle d'un bot ou d'un salon, repérée par son fil. */
type HiddenItem = { kind: "bot"; bot: BotDto } | { kind: "group"; group: GroupDto };

type BulkJob = { kind: "restore" | "purge"; bots: BotDto[] } | { kind: "reveal"; threadIds: string[] };

const BULK_DONE = {
  restore: "settingsArchives.restoredMany",
  purge: "settingsArchives.purgedMany",
  reveal: "settingsArchives.shownMany",
} as const;

/**
 * Un geste sur toute une sélection, un appel après l'autre : la suppression
 * passe par le runtime, et quinze appels simultanés le saturaient pour rien.
 * Un échec n'arrête pas les suivants ; chacun revient avec son erreur.
 */
async function eachInTurn<T>(items: readonly T[], call: (item: T) => Promise<unknown>): Promise<{ done: number; failed: unknown[] }> {
  const failed: unknown[] = [];
  for (const item of items) {
    try {
      await call(item);
    } catch (error) {
      failed.push(error);
    }
  }
  return { done: items.length - failed.length, failed };
}

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
 * est-ce que je l'ai mis de côté ». À droite, remettre en circulation, et
 * pour un bot supprimé ou archivé, l'effacer pour de bon.
 */
export function ArchivesSettings() {
  const viewer = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const canPurge = viewer.data?.session.role !== "agency";
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    refetchInterval: (query) => query.state.data?.bots.some((bot) => bot.hostCleanupStatus === "pending" || bot.hostCleanupStatus === "verifying") ? 2000 : false,
  });
  /** Les bots à supprimer définitivement, une fois confirmé : un seul ou une sélection. */
  const [deleting, setDeleting] = useState<BotDto[] | null>(null);

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
  const bulk = useMutation({
    mutationFn: async (job: BulkJob) => {
      const result = job.kind === "reveal"
        ? await eachInTurn(job.threadIds, (threadId) => api.showThread(threadId))
        : await eachInTurn(job.bots, (bot) => job.kind === "purge" ? api.purgeBot(bot.id) : api.updateBot(bot.id, { archived: false }));
      return { kind: job.kind, ...result };
    },
    onSuccess: async ({ kind, done, failed }) => {
      if (kind === "purge") setDeleting(null);
      if (done > 0) toast.success(t(BULK_DONE[kind], { count: done }));
      if (failed.length > 0) toast.error(t("settingsArchives.bulkFailed", { count: failed.length, message: errorMessage(failed[0], t("settingsArchives.actionFailed")) }));
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
  const hiddenItems = useMemo<HiddenItem[]>(
    () => [
      ...hiddenBots.map((bot) => ({ kind: "bot" as const, bot })),
      ...hiddenGroups.map((group) => ({ kind: "group" as const, group })),
    ],
    [hiddenBots, hiddenGroups],
  );
  const purging = remove.isPending || (bulk.isPending && bulk.variables?.kind === "purge");

  /** Restaurer et supprimer, sur la ligne d'un bot de la corbeille ou des archives. */
  const botRowActions = (bot: BotDto) => (
    <>
      <button
        type="button"
        className={ROW_ACTION}
        disabled={restore.isPending || bulk.isPending}
        onClick={() => restore.mutate(bot)}
      >
        {restore.isPending && restore.variables?.id === bot.id
          ? t("settingsArchives.restoring")
          : t("settingsArchives.restore")}
      </button>
      <button
        type="button"
        className={ROW_DANGER}
        disabled={!canPurge || bulk.isPending}
        title={!canPurge ? t("fleet.disabledAction") : undefined}
        onClick={() => { if (canPurge) { remove.reset(); setDeleting([bot]); } }}
      >
        {t("settingsArchives.delete")}
      </button>
    </>
  );

  /** Les mêmes gestes sur une sélection ; la suppression demande toujours confirmation. */
  const botBulkActions = (bots: BotDto[]) => (
    <>
      <button
        type="button"
        className={ROW_ACTION}
        disabled={bulk.isPending}
        onClick={() => bulk.mutate({ kind: "restore", bots })}
      >
        {bulk.isPending && bulk.variables?.kind === "restore"
          ? t("settingsArchives.restoring")
          : t("settingsArchives.restoreSelected", { count: bots.length })}
      </button>
      {canPurge ? (
        <button
          type="button"
          className={ROW_DANGER}
          disabled={bulk.isPending}
          onClick={() => { remove.reset(); setDeleting(bots); }}
        >
          {t("settingsArchives.deleteSelected", { count: bots.length })}
        </button>
      ) : null}
    </>
  );

  const nothingStored =
    roster.isSuccess &&
    trashedBots.length === 0 &&
    archivedBots.length === 0 &&
    hiddenItems.length === 0;

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
        <ArchiveSection
          title={t("settingsArchives.trashTitle")}
          description={t("settingsArchives.trashDescription")}
          items={trashedBots}
          keyOf={(bot) => bot.id}
          labelOf={(bot) => bot.name}
          busy={bulk.isPending}
          actions={(bots) => botBulkActions(bots)}
          renderRow={(bot, select) => (
            <StoredRow
              key={bot.id}
              select={select}
              avatar={<BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-9 opacity-60" />}
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
                    <button type="button" className={ROW_ACTION} disabled={retryCleanup.isPending} onClick={() => retryCleanup.mutate(bot.id)}>
                      {retryCleanup.isPending && retryCleanup.variables === bot.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                      {t("botHostCleanup.retry")}
                    </button>
                  ) : null}
                  {botRowActions(bot)}
                </>
              }
            />
          )}
        />
      ) : null}

      {archivedBots.length > 0 ? (
        <ArchiveSection
          title={t("settingsArchives.botsTitle")}
          description={t("settingsArchives.botsDescription")}
          items={archivedBots}
          keyOf={(bot) => bot.id}
          labelOf={(bot) => bot.name}
          busy={bulk.isPending}
          actions={(bots) => botBulkActions(bots)}
          renderRow={(bot, select) => (
            <StoredRow
              key={bot.id}
              select={select}
              avatar={<BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-9 opacity-75" />}
              title={bot.name}
              meta={t("settingsArchives.archivedOn", { date: formatDate(bot.archivedAt, locale) })}
              actions={botRowActions(bot)}
            />
          )}
        />
      ) : null}

      {hiddenItems.length > 0 ? (
        <ArchiveSection
          title={t("settingsArchives.hiddenTitle")}
          description={t("settingsArchives.hiddenDescription")}
          items={hiddenItems}
          keyOf={hiddenThreadId}
          labelOf={(item) => item.kind === "bot" ? item.bot.name : item.group.name}
          busy={bulk.isPending}
          actions={(items) => (
            <button
              type="button"
              className={ROW_ACTION}
              disabled={bulk.isPending}
              onClick={() => bulk.mutate({ kind: "reveal", threadIds: items.map(hiddenThreadId) })}
            >
              {bulk.isPending && bulk.variables?.kind === "reveal"
                ? t("settingsArchives.showing")
                : t("settingsArchives.showSelected", { count: items.length })}
            </button>
          )}
          renderRow={(item, select) => {
            const threadId = hiddenThreadId(item);
            const reveal_ = (
              <button
                type="button"
                className={ROW_ACTION}
                disabled={reveal.isPending}
                onClick={() => reveal.mutate(threadId)}
              >
                {reveal.isPending && reveal.variables === threadId
                  ? t("settingsArchives.showing")
                  : t("settingsArchives.show")}
              </button>
            );
            return item.kind === "bot" ? (
              <StoredRow
                key={threadId}
                select={select}
                avatar={<BotFace name={item.bot.name} seed={item.bot.id} face={item.bot.face} className="size-9 opacity-75" />}
                title={item.bot.name}
                meta={t("settingsArchives.activeOn", { date: formatDate(item.bot.lastActivityAt, locale) })}
                actions={reveal_}
              />
            ) : (
              <StoredRow
                key={threadId}
                select={select}
                avatar={<GroupFaceStack members={item.group.members} size="size-5" className="size-9 justify-center opacity-75" />}
                title={item.group.name}
                badge={<Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">{t("settingsArchives.room")}</Badge>}
                meta={t("settingsArchives.activeOn", { date: formatDate(item.group.lastActivityAt, locale) })}
                actions={reveal_}
              />
            );
          }}
        />
      ) : null}

      {deleting ? (
        <Dialog
          open
          onClose={() => { if (!purging) setDeleting(null); }}
          role="alertdialog"
          title={deleting.length === 1
            ? t("botContextMenu.purgeTitle", { name: deleting[0]!.name })
            : t("settingsArchives.purgeManyTitle", { count: deleting.length })}
          description={t("botContextMenu.purgeDescription")}
          closeLabel={t("common.close")}
          footer={
            <>
              <button
                type="button"
                className={BUTTON.secondary}
                disabled={purging}
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
                disabled={purging}
                onClick={() => {
                  if (deleting.length === 1) remove.mutate(deleting[0]!);
                  else bulk.mutate({ kind: "purge", bots: deleting });
                }}
              >
                {purging ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
                ) : null}
                {purging
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
  select,
  avatar,
  title,
  badge,
  meta,
  status,
  actions,
}: {
  /** La case de sélection de la ligne. */
  select: ReactNode;
  avatar: ReactNode;
  title: string;
  badge?: ReactNode;
  meta: string;
  status?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="flex shrink-0 items-center">{select}</span>
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

function hiddenThreadId(item: HiddenItem): string {
  return item.kind === "bot" ? item.bot.threadId : item.group.threadId;
}
