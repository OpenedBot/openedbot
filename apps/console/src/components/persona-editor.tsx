import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PERSONA_MAX_CHARS, personaMetrics } from "@openedbot/roster/domain/persona";
import { Dialog, Label, Textarea, cn } from "@openedbot/browser-ui-kit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import { documentMarkdownComponents } from "./thread-markdown";
import { BUTTON } from "./settings/primitives";

/**
 * L'éditeur de persona.
 *
 * Du texte BRUT, pas un éditeur riche : `instructions` part mot pour mot dans
 * le prompt, et le modèle lit déjà le markdown. Un éditeur riche poserait une
 * couche de sérialisation entre ce qu'on tape et ce que le bot reçoit, pour
 * un champ dont l'intérêt est justement qu'il n'y en ait aucune.
 *
 * Deux choses manquaient et coûtaient cher :
 *   - le compteur. L'API rognait à 100 000 caractères en silence ; elle refuse
 *     désormais, et le dépassement se lit ICI, avant l'envoi.
 *   - le coût. Cette persona repart à chaque run par-dessus le socle du
 *     runtime ; l'estimation de jetons met ce prix sous les yeux.
 */
export function PersonaEditor({
  value,
  onChange,
  botId,
}: {
  value: string;
  onChange: (next: string) => void;
  botId?: string;
}) {
  const { t, formatNumber } = useT();
  const queryClient = useQueryClient();
  const [dismissedFailure, setDismissedFailure] = useState(false);
  const draft = useQuery({
    queryKey: botId ? queryKeys.personaDraft(botId) : ["persona-draft", "idle"],
    queryFn: () => api.latestPersonaDraft(botId!),
    enabled: Boolean(botId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "starting" || status === "running" ? 2_000 : false;
    },
  });
  const requestDraft = useMutation({
    mutationFn: () => api.requestPersonaDraft(botId!),
    onSuccess: async () => {
      setDismissedFailure(false);
      if (botId) await queryClient.invalidateQueries({ queryKey: queryKeys.personaDraft(botId) });
    },
  });
  const confirmDraft = useMutation({
    mutationFn: () => api.confirmPersonaDraft(botId!, draft.data!.runId!, draft.data!.hash!),
    onSuccess: async (result) => {
      if (result.draft) onChange(result.draft);
      if (botId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.personaDraft(botId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      }
    },
  });
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const metrics = personaMetrics(value);
  const snippet = t("botSettingsDialog.layoutHintSnippet");

  useEffect(() => {
    setDismissedFailure(false);
  }, [draft.data?.runId]);

  const draftErrorOpen = Boolean(requestDraft.error || confirmDraft.error ||
    (draft.data?.status === "failed" && !dismissedFailure));
  const draftErrorMessage =
    (requestDraft.error instanceof ApiError && requestDraft.error.code === "RATE_LIMITED") ||
    (confirmDraft.error instanceof ApiError && confirmDraft.error.code === "RATE_LIMITED")
      ? t("botSettingsDialog.draftRateLimited")
      : requestDraft.error instanceof ApiError && requestDraft.error.code === "BOT_BUSY"
        ? t("botSettingsDialog.draftBusy")
        : confirmDraft.error instanceof ApiError && confirmDraft.error.code === "PERSONA_DRAFT_HASH_MISMATCH"
          ? t("botSettingsDialog.draftHashMismatch")
          : t("botSettingsDialog.draftFailed");
  const closeDraftError = () => {
    requestDraft.reset();
    confirmDraft.reset();
    setDismissedFailure(true);
  };

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copySnippet = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="bot-settings-instructions">{t("botSettingsDialog.instructionsLabel")}</Label>
        <div role="tablist" className="flex gap-1 text-xs">
          <Tab active={!preview} onSelect={() => setPreview(false)}>
            {t("botSettingsDialog.instructionsWrite")}
          </Tab>
          <Tab active={preview} onSelect={() => setPreview(true)}>
            {t("botSettingsDialog.instructionsPreview")}
          </Tab>
        </div>
      </div>

      {preview ? (
        <div
          role="tabpanel"
          className="scrollbar-subtle min-h-56 flex-1 overflow-auto rounded-lg border border-input bg-transparent px-2.5 py-2 prose prose-sm max-w-none wrap-anywhere dark:bg-input/30 dark:prose-invert prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5"
        >
          {value.trim()
            ? (
              <Markdown remarkPlugins={[remarkGfm]} components={documentMarkdownComponents}>
                {value}
              </Markdown>
            )
            : <p className="text-sm text-muted-foreground">{t("botSettingsDialog.instructionsPreviewEmpty")}</p>}
        </div>
      ) : (
        <Textarea
          id="bot-settings-instructions"
          role="tabpanel"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t("botSettingsDialog.instructionsPlaceholder")}
          spellCheck={false}
          aria-invalid={metrics.overLimit}
          className="scrollbar-subtle min-h-56 resize-y font-mono"
        />
      )}

      <p className="text-xs text-muted-foreground">{t("botSettingsDialog.instructionsHint")}</p>
      {botId ? (
        <div className="space-y-2 rounded-lg border border-border/60 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={requestDraft.isPending || draft.data?.status === "queued" || draft.data?.status === "running"}
              onClick={() => requestDraft.mutate()}
              className={BUTTON.secondary}
            >
              {requestDraft.isPending || draft.data?.status === "queued" || draft.data?.status === "running"
                ? t("botSettingsDialog.proposingDraft")
                : t("botSettingsDialog.proposeDraft")}
            </button>
          </div>
          {draft.data?.status === "completed" && draft.data.draft ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("botSettingsDialog.draftReady")}</p>
              <pre className="scrollbar-subtle max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background px-2.5 py-2 font-mono text-[11px] leading-5">
                {draft.data.draft}
              </pre>
              {draft.data.hash && draft.data.runId ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={confirmDraft.isPending}
                    onClick={() => confirmDraft.mutate()}
                    className={BUTTON.primary}
                  >
                    {t("botSettingsDialog.applyDraft")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <Dialog
            open={draftErrorOpen}
            onClose={closeDraftError}
            role="alertdialog"
            title={t("botSettingsDialog.draftErrorTitle")}
            description={draftErrorMessage}
            swipeToDismiss={false}
            closeLabel={t("common.close")}
            footer={
              <button type="button" className={BUTTON.primary} onClick={closeDraftError}>
                {t("common.close")}
              </button>
            }
          />
        </div>
      ) : null}
      <details className="rounded-lg border border-border/60 bg-surface-sunken/40 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("botSettingsDialog.layoutHintTitle")}
        </summary>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("botSettingsDialog.layoutHint")}</p>
        <pre className="scrollbar-subtle mt-2 overflow-x-auto rounded-md border border-border/50 bg-background px-2.5 py-2 font-mono text-[11px] leading-5">
          {snippet}
        </pre>
        <button
          type="button"
          onClick={() => void copySnippet()}
          className="mt-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? t("botSettingsDialog.layoutHintCopied") : t("botSettingsDialog.layoutHintCopy")}
        </button>
      </details>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground" title={t("botSettingsDialog.instructionsTokensHint")}>
          {t("botSettingsDialog.instructionsTokens", { tokens: formatNumber(metrics.estimatedTokens) })}
        </span>
        <span className={cn("tabular-nums", metrics.overLimit ? "text-destructive-text" : "text-muted-foreground")}>
          {metrics.overLimit
            ? t("botSettingsDialog.instructionsTooLong", { over: formatNumber(-metrics.remaining) })
            : t("botSettingsDialog.instructionsCount", {
                chars: formatNumber(metrics.chars),
                max: formatNumber(PERSONA_MAX_CHARS),
              })}
        </span>
      </div>
    </div>
  );
}

function Tab({
  active,
  onSelect,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "rounded px-2 py-1",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
