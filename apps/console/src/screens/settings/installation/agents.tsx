import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconServerBolt } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
import type { RuntimeHostProfileDto, RuntimeProfileDeleteJobDto } from "@openedbot/contracts-api";
import {
  Badge,
  Checkbox,
  Dialog,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  toast,
  useIsMobile,
} from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { InsetGroupedSection, MobileActionFooter } from "../../../components/mobile/inset-grouped";
import { HermesBundleImport } from "../../../components/hermes-bundle-import";
import { ProfileImportReport } from "../../../components/profile-import-report";
import { ACTIONS, ALIVE_BADGE, BUTTON, EmptyState, Note, SectionHeading, SettingsCard, ToneBadge } from "../../../components/settings/primitives";
import { SettingsPane } from "../pane";
import { HostProfilesTable } from "./agents/agents-table";

type AgentsTab = "host" | "archive";

const EMPTY_PROFILES: RuntimeHostProfileDto[] = [];

function canImportProfile(profile: RuntimeHostProfileDto): boolean {
  return !profile.alreadyImported && !profile.hidden;
}

/**
 * Runtime agents, two tabs: an inventory of the profiles already present
 * on the host (roster import, deletion if the operator announces it), and
 * a ZIP / TGZ archive. Desktop: DataTable. Phone: grouped list.
 */
export function AgentsSettings() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AgentsTab>("host");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<RuntimeHostProfileDto[] | null>(null);
  const configuration = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
  });
  const noRuntime = configuration.isSuccess && configuration.data.runtime === null;
  const inventory = useQuery({
    queryKey: queryKeys.runtimeProfiles,
    queryFn: api.runtimeProfiles,
    retry: false,
    enabled: !noRuntime,
  });
  const jobs = useQuery({
    queryKey: queryKeys.hermesImportJobs,
    queryFn: () => api.hermesImportJobs(),
    retry: false,
  });
  const deleteJobs = useQuery({
    queryKey: queryKeys.runtimeProfileDeleteJobs,
    queryFn: api.runtimeProfileDeleteJobs,
    retry: false,
    refetchInterval: (query) => {
      const active = (query.state.data?.jobs ?? []).some(
        (job) => job.status === "queued" || job.status === "running",
      );
      return active ? 2000 : false;
    },
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const observedDeletes = useRef(new Map<string, string>());
  useEffect(() => {
    for (const job of deleteJobs.data?.jobs ?? []) {
      const previous = observedDeletes.current.get(job.id);
      observedDeletes.current.set(job.id, job.updatedAt);
      if (job.status === "queued" || job.status === "running") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
        continue;
      }
      if (!previous || previous === job.updatedAt) continue;
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      const failed = job.results.filter((item) => !item.ok).length;
      if (job.status === "succeeded") {
        toast.success(t("profileImport.deleteSelectedSuccess", { count: String(job.totalProfiles) }));
      } else if (failed > 0) {
        toast.error(t("profileImport.deleteJobPartial", { failed: String(failed) }));
      } else {
        toast.error(errorMessage(undefined, t("profileImport.deleteFailed")));
      }
    }
  }, [deleteJobs.data, queryClient, t]);
  const profiles = useMemo(() => inventory.data?.profiles ?? EMPTY_PROFILES, [inventory.data]);
  const canDelete = inventory.data?.canDelete === true;
  const importable = profiles.filter(canImportProfile).length;
  const deletable = canDelete ? profiles.length : 0;
  const selectedImportable = profiles.filter((profile) => selected.has(profile.name) && canImportProfile(profile));
  const activeJobs = (jobs.data?.jobs ?? []).filter(
    (job) => job.status === "queued" || job.status === "running" || job.status === "needs_attention",
  ).length;

  const toggle = (slug: string): void => {
    const profile = profiles.find((item) => item.name === slug);
    if (!profile || !canImportProfile(profile)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const toggleAll = (slugs: string[], checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      for (const slug of slugs) {
        if (checked) next.add(slug);
        else next.delete(slug);
      }
      return next;
    });
  };

  const importProfiles = useMutation({
    mutationFn: (slugs: string[]) => api.importRuntimeProfiles({ profiles: slugs }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
      setSelected(new Set());
      toast.success(t("profileImport.success", { count: String(result.imported.length) }));
    },
    onError: (error) => toast.error(errorMessage(error, t("profileImport.failed"))),
  });
  const deleteProfile = useMutation({
    mutationFn: async (targets: RuntimeHostProfileDto[]) => {
      if (targets.length === 1) {
        await api.deleteRuntimeProfile(targets[0]!.name);
        return targets;
      }
      await api.enqueueRuntimeProfileDelete(targets.map((profile) => profile.name));
      return targets;
    },
    onSuccess: async (targets) => {
      setDeleting(null);
      if (targets.length === 1) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
        await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
        setSelected((current) => {
          const next = new Set(current);
          next.delete(targets[0]!.name);
          return next;
        });
        toast.success(t("profileImport.deleteSuccess", { name: targets[0]!.displayName }));
        return;
      }
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfileDeleteJobs });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfileDeleteJobs });
      toast.error(errorMessage(error, t("profileImport.deleteFailed")));
    },
  });
  const selectedProfiles = profiles.filter((profile) => selected.has(profile.name));
  const activeDeleteJob = (deleteJobs.data?.jobs ?? []).find(
    (job) => job.status === "queued" || job.status === "running",
  ) ?? null;
  const deletingSlugs = new Set(activeDeleteJob?.slugs ?? []);
  const jobBusy = activeDeleteJob !== null;
  const deleteBusy = deleteProfile.isPending || jobBusy;
  const bulkDelete = selected.size >= 2 && canDelete && !jobBusy;

  const importDisabled = selectedImportable.length === 0 || importProfiles.isPending;
  const importAction = (
    <button
      type="button"
      className={BUTTON.primary}
      disabled={importProfiles.data ? false : importDisabled}
      onClick={() => {
        if (importProfiles.data) importProfiles.reset();
        else importProfiles.mutate(selectedImportable.map((profile) => profile.name));
      }}
    >
      {importProfiles.data
        ? t("profileImport.continue")
        : importProfiles.isPending
          ? t("profileImport.importing")
          : t("profileImport.import")}
    </button>
  );
  const configureRuntime = (
    <Link to="/settings/runtime" className={BUTTON.primary}>
      {t("profileImport.configureRuntime")}
    </Link>
  );
  const hostFooter = tab === "host" && inventory.data ? (
    <>
      {importAction}
      {bulkDelete ? (
        <button
          type="button"
          className={BUTTON.danger}
          disabled={deleteBusy}
          onClick={() => setDeleting(selectedProfiles)}
        >
          {t("profileImport.deleteSelected", { count: String(selected.size) })}
        </button>
      ) : null}
    </>
  ) : undefined;
  const paneFooter = noRuntime
    ? isMobile ? configureRuntime : undefined
    : isMobile
      ? hostFooter
      : importProfiles.data && tab === "host"
        ? importAction
        : undefined;

  const deleteFooter = deleting ? (
    <>
      <button
        type="button"
        disabled={deleteProfile.isPending}
        onClick={() => setDeleting(null)}
        className={BUTTON.secondary}
      >
        {t("common.cancel")}
      </button>
      <button
        type="button"
        disabled={deleteProfile.isPending || jobBusy}
        onClick={() => deleteProfile.mutate(deleting)}
        className={BUTTON.danger}
      >
        {deleteProfile.isPending ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("profileImport.deleteConfirm")}
          </span>
        ) : (
          t("profileImport.deleteConfirm")
        )}
      </button>
    </>
  ) : null;

  const hostDescription = (
    <>
      {t("profileImport.settingsHint")}
      {inventory.data ? (
        <span className="mt-2 block" role="status">
          {t("profileImport.counts", {
            importable: String(importable),
            deletable: String(deletable),
          })}
        </span>
      ) : null}
    </>
  );

  return (
    <SettingsPane footer={paneFooter}>
      <SectionHeading
        title={t("settingsSidebar.agents")}
        description={tab === "host" ? hostDescription : t("profileImport.archiveHint")}
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "host" || value === "archive") setTab(value);
        }}
        className="min-h-0 flex-1 gap-4"
      >
        <div data-inset-grouped="">
          <TabsList className="w-fit">
            <TabsTrigger value="host" className="px-4">
              {t("profileImport.tabHost")}
              {activeDeleteJob ? (
                <Badge variant="secondary" className="ml-1">{activeDeleteJob.completedProfiles}/{activeDeleteJob.totalProfiles}</Badge>
              ) : importable > 0 ? (
                <Badge variant="secondary" className="ml-1">{importable}</Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="archive" className="px-4">
              {t("profileImport.tabArchive")}
              {activeJobs > 0 ? (
                <Badge variant="secondary" className="ml-1">{activeJobs}</Badge>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </div>
        {activeDeleteJob ? <DeleteJobProgress job={activeDeleteJob} /> : null}
        <TabsContent value="host" className="flex min-h-0 flex-1 flex-col gap-5">
          {noRuntime ? (
            <NoRuntimeCard
              description={t("profileImport.noRuntimeHostDescription")}
              action={configureRuntime}
              showAction={!isMobile}
            />
          ) : inventory.isPending || configuration.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">{t("profileImport.loading")}</p>
          ) : inventory.isError || inventory.data === null ? (
            <EmptyState
              icon={<IconServerBolt />}
              title={t("profileImport.unavailable")}
              description={t("profileImport.unavailableHint")}
            />
          ) : (
            <>
              {!canDelete ? (
                <Note tone="warning">{t("profileImport.canDeleteUnavailable")}</Note>
              ) : null}
              {importProfiles.data ? (
                <ProfileImportReport result={importProfiles.data} />
              ) : profiles.length === 0 && !activeDeleteJob ? (
                <p className="text-sm text-muted-foreground">{t("profileImport.empty")}</p>
              ) : isMobile ? (
                <HostProfilesMobile
                  profiles={profiles}
                  selected={selected}
                  onToggle={toggle}
                  canDelete={canDelete}
                  onDelete={(profile) => setDeleting([profile])}
                  deleting={deleteBusy}
                  bulkDelete={bulkDelete}
                  deletingSlugs={deletingSlugs}
                />
              ) : (
                <HostProfilesTable
                  profiles={profiles}
                  selected={selected}
                  onToggle={toggle}
                  onToggleAll={toggleAll}
                  canDelete={canDelete}
                  onDelete={(profile) => setDeleting([profile])}
                  onDeleteSelected={() => setDeleting(selectedProfiles)}
                  deleting={deleteBusy}
                  deletingSlugs={deletingSlugs}
                  importAction={importAction}
                />
              )}
            </>
          )}
        </TabsContent>
        <TabsContent value="archive" className="flex min-h-0 flex-1 flex-col">
          {noRuntime ? (
            <NoRuntimeCard
              description={t("profileImport.noRuntimeArchiveDescription")}
              action={configureRuntime}
              showAction={!isMobile}
            />
          ) : configuration.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">{t("profileImport.loading")}</p>
          ) : (
            <SettingsCard className="space-y-5">
              <HermesBundleImport showTitle={false} />
            </SettingsCard>
          )}
        </TabsContent>
      </Tabs>
      {deleting ? (
        <Dialog
          open
          onClose={() => {
            if (!deleteProfile.isPending) setDeleting(null);
          }}
          role="alertdialog"
          title={
            deleting.length === 1
              ? t("profileImport.deleteTitle")
              : t("profileImport.deleteSelectedTitle", { count: String(deleting.length) })
          }
          description={
            deleting.length === 1
              ? t("profileImport.deleteDescription", { name: deleting[0]!.displayName })
              : t("profileImport.deleteSelectedDescription", { count: String(deleting.length) })
          }
          closeLabel={t("common.close")}
          className="max-w-lg"
          swipeToDismiss={false}
          footer={isMobile ? undefined : <div className={ACTIONS}>{deleteFooter}</div>}
        >
          {deleting.some((profile) => profile.alreadyImported) || isMobile ? (
            <>
              {deleting.some((profile) => profile.alreadyImported) ? (
                <p>{deleting.length === 1 ? t("profileImport.deleteWithBot") : t("profileImport.deleteSelectedWithBot")}</p>
              ) : null}
              {isMobile ? <MobileActionFooter>{deleteFooter}</MobileActionFooter> : null}
            </>
          ) : null}
        </Dialog>
      ) : null}
    </SettingsPane>
  );
}

function NoRuntimeCard({
  description,
  action,
  showAction,
}: {
  description: string;
  action: ReactNode;
  showAction: boolean;
}) {
  const { t } = useT();
  return (
    <EmptyState
      icon={<IconServerBolt />}
      title={t("profileImport.noRuntimeTitle")}
      description={description}
      actions={showAction ? action : undefined}
    />
  );
}

function DeleteJobProgress({ job }: { job: RuntimeProfileDeleteJobDto }) {
  const { t } = useT();
  const running = job.status === "queued" || job.status === "running";
  const percent = job.totalProfiles === 0 ? 0 : Math.round((job.completedProfiles / job.totalProfiles) * 100);
  const label = job.currentSlug
    ? t("profileImport.deleteProgressCurrent", {
      name: job.currentSlug,
      done: String(job.completedProfiles),
      total: String(job.totalProfiles),
    })
    : t("profileImport.deleteProgress", {
      done: String(job.completedProfiles),
      total: String(job.totalProfiles),
    });
  const status = job.status === "queued"
    ? t("profileImport.deleteJobQueued")
    : job.status === "running"
      ? t("profileImport.deleteJobRunning")
      : job.status === "succeeded"
        ? t("profileImport.deleteJobSucceeded")
        : t("profileImport.deleteJobFailed");
  return (
    <div className="space-y-2 rounded-lg border border-border p-4" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-sm">
        {running ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : null}
        <span>
          {status}
          {" · "}
          {label}
        </span>
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={job.totalProfiles}
        aria-valuenow={job.completedProfiles}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className="h-full rounded-full bg-foreground/70 transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      {running ? <p className="text-xs text-muted-foreground">{t("profileImport.deleteBackground")}</p> : null}
    </div>
  );
}

function HostProfilesMobile({
  profiles,
  selected,
  onToggle,
  canDelete,
  onDelete,
  deleting,
  bulkDelete,
  deletingSlugs,
}: {
  profiles: RuntimeHostProfileDto[];
  selected: ReadonlySet<string>;
  onToggle: (slug: string) => void;
  canDelete: boolean;
  onDelete: (profile: RuntimeHostProfileDto) => void;
  deleting: boolean;
  bulkDelete: boolean;
  deletingSlugs: ReadonlySet<string>;
}) {
  const { t } = useT();
  return (
    <InsetGroupedSection className="pt-0">
      {profiles.map((profile) => {
        const importable = canImportProfile(profile);
        const mission = profile.description?.trim() || t("profileImport.missionMissing");
        const model = profile.model.default ?? t("profileImport.modelUnknown");
        return (
          <li key={profile.name} className="border-b border-[var(--openedbot-grouped-separator)] last:border-b-0">
            <div className="flex min-h-12 items-start gap-3 px-4 py-3">
              {importable ? (
                <Checkbox
                  className="mt-1"
                  checked={selected.has(profile.name)}
                  onCheckedChange={() => onToggle(profile.name)}
                  aria-label={t("profileImport.selectRow", { name: profile.displayName })}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-[17px] leading-[22px]">{profile.displayName}</span>
                  {profile.alreadyImported ? (
                    <ToneBadge tone="info" className="whitespace-nowrap">{t("profileImport.inRoster")}</ToneBadge>
                  ) : null}
                  {profile.hidden ? (
                    <ToneBadge tone="neutral" className="whitespace-nowrap">{t("profileImport.hidden")}</ToneBadge>
                  ) : null}
                  {importable ? (
                    <ToneBadge tone="success" className={cn("whitespace-nowrap", ALIVE_BADGE)}>
                      {t("profileImport.toImport")}
                    </ToneBadge>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">{mission}</p>
                <p className="mt-1 font-mono text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
                  {model}
                  {" · "}
                  {t("profileImport.routines", { count: String(profile.routineCount) })}
                </p>
              </div>
            </div>
            {canDelete ? (
              <div className="flex justify-end px-4 pb-3">
                <button
                  type="button"
                  disabled={deleting || bulkDelete || deletingSlugs.has(profile.name)}
                  onClick={() => onDelete(profile)}
                  className={BUTTON.danger}
                >
                  {t("profileImport.deleteHost")}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </InsetGroupedSection>
  );
}
