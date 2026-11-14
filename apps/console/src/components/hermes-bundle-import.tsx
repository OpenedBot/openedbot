import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconUpload } from "@tabler/icons-react";
import { cn } from "@openedbot/browser-ui-kit";
import type { HermesBundleImportInput, HermesBundleImportJobDto, HermesProfileImportEntry } from "@openedbot/contracts-api";
import { collectHermesProfiles, hermesArchiveSlug, HERMES_IMPORT_MAX_JSON_BYTES, parseHermesProfileFiles } from "@openedbot/portability/domain/hermes-profile-bundle";
import { api, errorMessage, queryKeys } from "../lib/api";
import { readHermesArchive } from "../lib/bots/hermes-archive";
import { useT } from "../lib/i18n";
import { randomId } from "../lib/random-id";
import { BUTTON } from "./settings/primitives";
import { ImportLimitation, ProfileImportReport } from "./profile-import-report";

export function HermesBundleImport({
  onContinue,
  showTitle = true,
}: {
  onContinue?: () => void;
  showTitle?: boolean;
} = {}) {
  // Reset unsent projections and request keys on organization changes.
  return <BundleImport key={JSON.stringify(queryKeys.hermesImportJobs)} onContinue={onContinue} showTitle={showTitle} />;
}

function useImportJobs() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.hermesImportJobs;
  const observed = useRef(new Map<string, string>());
  const jobs = useQuery({ queryKey, queryFn: () => api.hermesImportJobs(), refetchInterval: 2000, refetchOnWindowFocus: "always", refetchOnReconnect: "always", retry: false });
  useEffect(() => {
    for (const job of jobs.data?.jobs ?? []) {
      if (job.result && observed.current.get(job.id) !== job.updatedAt) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
        void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
      }
      observed.current.set(job.id, job.updatedAt);
    }
  }, [jobs.data, queryClient]);
  return jobs;
}

function BundleImport({ onContinue, showTitle }: { onContinue?: () => void; showTitle: boolean }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const jobs = useImportJobs();
  const [archive, setArchive] = useState<Awaited<ReturnType<typeof collectArchive>> | null>(null);
  const [rootSlug, setRootSlug] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(new Set<string>());
  const [request, setRequest] = useState<HermesBundleImportInput | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const preview = useMemo(() => {
    const entries: HermesProfileImportEntry[] = [], notes: string[] = [];
    for (const candidate of archive?.candidates ?? []) {
      const parsed = parseHermesProfileFiles(candidate.root ? rootSlug : candidate.slug, candidate.files);
      if ("issue" in parsed) notes.push(`${parsed.issue.code}:${parsed.issue.slug}`);
      else { entries.push(parsed.entry); notes.push(...parsed.notes); if (parsed.ignoredKeys.length) notes.push(`configuration-fields-excluded:${parsed.entry.name}:${parsed.ignoredKeys.length}`); }
    }
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    for (const [slug, count] of counts) if (count > 1) notes.push(`slug-duplicate:${slug}`);
    return { entries: entries.filter((entry) => counts.get(entry.name) === 1), notes };
  }, [archive, rootSlug]);
  const submit = useMutation({ mutationFn: api.importHermesBundle, onSuccess: () => {
    setArchive(null); setRequest(null); setSelected(new Set());
    void queryClient.invalidateQueries({ queryKey: queryKeys.hermesImportJobs });
  } });
  async function choose(file: File) {
    const current = ++generation.current;
    setReading(true); setError(null); setArchive(null); setRequest(null); submit.reset();
    try {
      const result = await collectArchive(file);
      if (current !== generation.current) return;
      setRootSlug(hermesArchiveSlug(file.name)); setArchive(result);
      setSelected(new Set(result.candidates.flatMap((candidate) => {
        const parsed = parseHermesProfileFiles(candidate.slug, candidate.files);
        return "entry" in parsed && !parsed.entry.uiMeta?.hidden ? [candidate.slug] : [];
      }).slice(0, 32)));
    } catch { if (current === generation.current) setError(t("profileImport.archiveInvalid")); }
    finally { if (current === generation.current) setReading(false); }
  }
  function confirm() {
    const input = request ?? { profiles: preview.entries.filter((entry) => selected.has(entry.name)), idempotencyKey: randomId() };
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > HERMES_IMPORT_MAX_JSON_BYTES) { setError(t("profileImport.archiveInvalid")); return; }
    setRequest(input); submit.mutate(input);
  }
  const busy = reading || submit.isPending;
  return <section className="space-y-4" aria-label={t("profileImport.archiveTitle")}>
    {showTitle ? <h3 className="text-sm font-semibold tracking-tight">{t("profileImport.archiveTitle")}</h3> : null}
    {/*
      A drop zone, not the native input: « Choisir un fichier Aucun fichier
      choisi » is the only line of the screen the system draws in our
      place, and it says neither the format nor the limit. The input stays in the
      DOM (sr-only): it is what the button opens and what the tests fill in.
    */}
    <div
      data-dragging={dragging ? "" : undefined}
      onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file && !busy) void choose(file); }}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border",
        busy && "opacity-60",
      )}
    >
      <IconUpload aria-hidden className="size-6 text-muted-foreground" stroke={1.5} />
      <div className="space-y-1">
        <p className="text-sm">{t("profileImport.archiveDrop")}</p>
        <p className="max-w-[52ch] text-xs leading-5 text-muted-foreground">{t("profileImport.archiveHint")}</p>
      </div>
      <input ref={fileInput} type="file" accept=".zip,.tgz,.tar.gz" className="sr-only" disabled={busy} aria-label={t("profileImport.archiveTitle")} onChange={(event) => { const file = event.target.files?.[0]; if (file) void choose(file); event.target.value = ""; }} />
      <button type="button" className={BUTTON.secondary} disabled={busy} onClick={() => fileInput.current?.click()}>{t("profileImport.archiveChoose")}</button>
    </div>
    {reading ? <p role="status">{t("profileImport.archiveReading")}</p> : null}
    {archive ? <div className="space-y-3">
      {archive.candidates.some((item) => item.root) ? <label className="block">{t("profileImport.rootSlug")}<input className="ml-2 rounded border p-2" value={rootSlug} disabled={!!request} onChange={(event) => { const slug = event.target.value; setSelected((previous) => { const next = new Set(previous); if (next.delete(rootSlug)) next.add(slug); return next; }); setRootSlug(slug); }} /></label> : null}
      <p className="text-sm">{t("profileImport.archiveExcluded", { count: archive.dropped.length })}</p>
      <ul>{[...archive.issues.map((item) => `${item.code}:${item.slug}`), ...preview.notes].map((note, i) => <li key={i} className="text-sm"><ImportLimitation note={note} /></li>)}</ul>
      {preview.entries.map((entry) => <label key={entry.name} className="flex items-start gap-3 rounded border p-3">
        <input type="checkbox" checked={selected.has(entry.name)} disabled={!!request || (!selected.has(entry.name) && selected.size >= 32)} onChange={() => setSelected((previous) => { const next = new Set(previous); if (!next.delete(entry.name)) next.add(entry.name); return next; })} />
        <span><strong>{entry.displayName}</strong> · {entry.name}{entry.uiMeta?.hidden ? ` · ${t("profileImport.hidden")}` : ""}<span className="block text-sm">{entry.description}</span><span className="block text-sm">{t("profileImport.model", { model: entry.model.default ?? t("profileImport.modelUnknown") })} · {t("profileImport.routines", { count: entry.routines.length })}</span></span>
      </label>)}
      <p className="text-sm text-muted-foreground">{t("profileImport.archiveConfirm")}</p>
      <button type="button" className={BUTTON.primary} disabled={submit.isPending || !preview.entries.some((entry) => selected.has(entry.name))} onClick={confirm}>{submit.isPending ? t("profileImport.importing") : request ? t("profileImport.retrySubmission") : t("profileImport.import")}</button>
      {request && !submit.isPending ? <button type="button" className={BUTTON.secondary} onClick={() => { setRequest(null); submit.reset(); }}>{t("profileImport.newConfirmation")}</button> : null}
    </div> : null}
    {error || submit.error ? <p role="alert">{error ?? errorMessage(submit.error, t("profileImport.failed"))}</p> : null}
    {jobs.isError ? <p role="status">{t("profileImport.trackingOffline")}</p> : null}
    {jobs.data?.jobs.filter((job) => !dismissed.has(job.id)).map((job) => <ImportJob key={job.id} job={job} onContinue={() => { setDismissed((previous) => new Set([...previous, job.id])); onContinue?.(); }} />)}
  </section>;
}

async function collectArchive(file: File) {
  const archive = await readHermesArchive(file);
  const profiles = collectHermesProfiles({ entries: archive.entries, archiveName: file.name });
  return { ...profiles, dropped: [...archive.dropped, ...profiles.dropped] };
}

function ImportJob({ job, onContinue }: { job: HermesBundleImportJobDto; onContinue: () => void }) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  const [verified, setVerified] = useState(false);
  const acknowledge = useMutation({ mutationFn: () => api.acknowledgeHermesImport(job.id), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.hermesImportJobs }); } });
  return <article className="space-y-3 rounded border p-4">
    <p role="status">{t(`profileImport.status.${job.status}`)} · {job.completedProfiles}/{job.totalProfiles} · {formatDate(job.createdAt)}</p>
    {job.status === "running" || job.status === "queued" ? <p className="text-sm">{t("profileImport.background")}</p> : null}
    {job.result ? <ProfileImportReport result={job.result} /> : null}
    {job.error ? <p role="alert">{job.error.message} {job.error.details?.unconfirmedProfiles?.join(", ")}</p> : null}
    {job.status === "needs_attention" ? <div className="space-y-3">
      <label className="flex gap-2"><input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} />{t("profileImport.verifyHost")}</label>
      <button type="button" className={BUTTON.secondary} disabled={!verified || acknowledge.isPending} onClick={() => acknowledge.mutate()}>{t("profileImport.acknowledge")}</button>
      {acknowledge.error ? <p role="alert">{errorMessage(acknowledge.error, t("profileImport.failed"))}</p> : null}
    </div> : null}
    {job.status === "succeeded" || job.status === "failed" ? <button type="button" className={BUTTON.secondary} onClick={onContinue}>{t("profileImport.continue")}</button> : null}
  </article>;
}
