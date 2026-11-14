import { useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Dialog } from "@openedbot/browser-ui-kit";
import type { ConversationFileDto } from "@openedbot/contracts-api";
import { api, queryKeys, userFacingError, type ThreadView } from "../lib/api";
import { saveProductBlob } from "../lib/api/mvp";
import { mergeThreadHistory } from "../lib/thread/thread-history";
import { requestThreadReveal } from "../lib/thread/thread-reveal";
import { useT } from "../lib/i18n";
import { useAttachmentCanvas } from "./attachment-canvas";
import { BUTTON } from "./settings/primitives";

export function ConversationFiles({
  threadId,
  botId,
}: {
  threadId: string;
  botId?: string;
}) {
  const { t, formatDate } = useT();
  const client = useQueryClient();
  const canvas = useAttachmentCanvas();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const canExportBot =
    botId &&
    (me.data?.session.role === "owner" || me.data?.session.role === "admin");
  const page = useInfiniteQuery({
    queryKey: queryKeys.conversationFiles(threadId, search),
    queryFn: ({ pageParam }) =>
      api.conversationFiles(threadId, search, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
    enabled: open,
    staleTime: 0,
  });
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(userFacingError(failure, t("mvp.exportError")));
    } finally {
      setBusy(false);
    }
  };
  const source = async (file: ConversationFileDto) => {
    let history =
      client.getQueryData<ThreadView>(queryKeys.thread(threadId)) ??
      (await api.thread(threadId));
    const cursors = new Set<string>();
    const started = Date.now();
    while (!history.messages.some((m) => m.id === file.messageId)) {
      const cursor = history.history?.nextBefore;
      if (!cursor || cursors.has(cursor) || Date.now() - started > 30_000)
        throw new Error("Source message could not be loaded");
      cursors.add(cursor);
      history = mergeThreadHistory(
        history,
        await api.thread(threadId, cursor),
        "older",
      );
    }
    client.setQueryData(queryKeys.thread(threadId), history);
    setOpen(false);
    window.setTimeout(
      () =>
        requestThreadReveal(`message:${file.messageId}`, { block: "center" }),
      100,
    );
  };
  return (
    <>
      <button
        type="button"
        className={BUTTON.small}
        onClick={() => setOpen(true)}
      >
        {t("mvp.files")}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("mvp.files")}
        description={t("mvp.exportHint")}
        className="max-w-2xl"
      >
        <input
          type="search"
          aria-label={t("mvp.searchFiles")}
          placeholder={t("mvp.searchFiles")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-3 w-full rounded-lg border bg-background px-3 py-2 text-sm"
        />
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            className={BUTTON.small}
            disabled={busy}
            onClick={() =>
              void perform(async () =>
                saveProductBlob(
                  await api.exportProduct("threads", threadId),
                  `conversation-${threadId}.md`,
                ),
              )
            }
          >
            {t("mvp.exportThread")}
          </button>
          {canExportBot ? (
            <button
              className={BUTTON.small}
              disabled={busy}
              onClick={() =>
                void perform(async () =>
                  saveProductBlob(
                    await api.exportProduct("bots", botId),
                    `bot-${botId}.json`,
                  ),
                )
              }
            >
              {t("mvp.exportBot")}
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mb-2 text-sm text-destructive-text">
            {error}
          </p>
        ) : null}
        {page.isPending ? (
          <p role="status">{t("common.loading")}</p>
        ) : page.isError ? (
          <p role="alert">
            {t("mvp.loadError")}{" "}
            <button onClick={() => void page.refetch()}>
              {t("errorState.retry")}
            </button>
          </p>
        ) : (
          <ul className="max-h-[50vh] space-y-3 overflow-y-auto">
            {page.data.pages
              .flatMap((p) => p.files)
              .map((file) => (
                <li
                  key={file.id}
                  className="rounded-lg border border-border p-3 text-sm"
                >
                  <p className="break-words font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(file.createdAt)} ·{" "}
                    {file.role === "assistant"
                      ? t("mvp.produced")
                      : t("mvp.received")}{" "}
                    · {file.contentType}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      className={BUTTON.small}
                      disabled={busy}
                      onClick={() => {
                        if (!canvas)
                          throw new Error(
                            "AttachmentCanvasProvider is required",
                          );
                        canvas.open(file);
                        setOpen(false);
                      }}
                    >
                      {t("mvp.preview")}
                    </button>
                    <button
                      className={BUTTON.small}
                      disabled={busy}
                      onClick={() =>
                        void perform(async () =>
                          saveProductBlob(
                            await api.attachment(file.id),
                            file.name,
                          ),
                        )
                      }
                    >
                      {t("mvp.download")}
                    </button>
                    <button
                      className={BUTTON.small}
                      disabled={busy}
                      onClick={() => void perform(() => source(file))}
                    >
                      {t("mvp.source")}
                    </button>
                  </div>
                </li>
              ))}
            {page.data.pages.every((p) => !p.files.length) ? (
              <li>{t("mvp.emptyFiles")}</li>
            ) : null}
          </ul>
        )}
        {page.hasNextPage ? (
          <button
            className={`${BUTTON.small} mt-3`}
            disabled={page.isFetchingNextPage}
            onClick={() => void page.fetchNextPage()}
          >
            {t("mvp.more")}
          </button>
        ) : null}
      </Dialog>
    </>
  );
}
