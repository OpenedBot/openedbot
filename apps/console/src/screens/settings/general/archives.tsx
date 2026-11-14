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
 * An archive row's actions: the pills of the other settings
 * (`BUTTON`, like Runtime's « Vérifier le lien » and « Retirer »), a neutral
 * veil to put back into circulation, solid red to erase. Below 768 px
 * the pill rises to 44 pt high: that is the PWA contract's minimum touch
 * target, and an archive is consulted mostly with the thumb.
 */
const ROW_TOUCH = "max-md:h-11 max-md:px-3.5";
const ROW_ACTION = cn(BUTTON.secondary, ROW_TOUCH);
const ROW_DANGER = cn(BUTTON.danger, ROW_TOUCH);

/** A hidden conversation: a bot's or a Salon's, identified by its thread. */
type HiddenItem = { kind: "bot"; bot: BotDto } | { kind: "group"; group: GroupDto };

type BulkJob = { kind: "restore" | "purge"; bots: BotDto[] } | { kind: "reveal"; threadIds: string[] };

const BULK_DONE = {
  restore: "settingsArchives.restoredMany",
  purge: "settingsArchives.purgedMany",
  reveal: "settingsArchives.shownMany",
} as const;

/**
 * A gesture on a whole selection, one call after another: deletion
 * goes through the runtime, and fifteen simultaneous calls saturated it for nothing.
 * A failure does not stop the following ones; each comes back with its error.
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
 * The archives: the room where everything one puts away lands.
 *
 * Before, two folds lived at the bottom of the sidebar: « Archivés » and
 * « Masqués », each with its chevron, under the conversation list. Two
 * disclosures for rows one almost never consults, and that
 * pushed the live list upward: on the phone, they occupied the
 * thumb's zone. They are here, in the gear, where the other
 * lasting decisions live.
 *
 * An archive row is NOT a greyed conversation row: it is a
 * register card. Face muted, name, and the filing date in
 * tabular figures: what one looks for in an archive is "when
 * did I set it aside". On the right, put back into circulation, and
 * for a deleted or archived bot, erase it for good.
 */
export function ArchivesSettings() {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    refetchInterval: (query) => query.state.data?.bots.some((bot) => bot.hostCleanupStatus === "pending" || bot.hostCleanupStatus === "verifying") ? 2000 : false,
  });
  /** The bots to delete permanently, once confirmed: a single one or a selection. */
  const [deleting, setDeleting] = useState<BotDto[] | null>(null);

  // A single roster key: archives, sidebar and palette share the cache.
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

  // Archiving wins over hiding: a bot both archived and hidden
  // appears only once, in the section that describes what happened to it
  // that is stronger. And the trash wins over archiving, for the same reason:
  // « supprimé » is a stronger fact than « rangé », even though the server sets
  // both dates together always (invariant of migration 0031).
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

  /** Restore and delete, on the row of a bot from the trash or the archives. */
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
        disabled={bulk.isPending}
        onClick={() => { remove.reset(); setDeleting([bot]); }}
      >
        {t("settingsArchives.delete")}
      </button>
    </>
  );

  /** The same gestures on a selection; deletion always asks for confirmation. */
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
      <button
        type="button"
        className={ROW_DANGER}
        disabled={bulk.isPending}
        onClick={() => { remove.reset(); setDeleting(bots); }}
      >
        {t("settingsArchives.deleteSelected", { count: bots.length })}
      </button>
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
              {/* The second gesture exists only after a refusal from the runtime: as long as
                  one has not tried, « supprimer chez openedbot seul » is not
                  an option to offer: that would be teaching how to bypass it. */}
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
 * A register card: face muted, name, filing date, and the
 * actions on the right. The actions wrap under the name below
 * 30rem: on a narrow phone, a long name and two buttons do not fit
 * side by side without cropping one of them under the 44 pt target.
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
  /** The row's selection checkbox. */
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
