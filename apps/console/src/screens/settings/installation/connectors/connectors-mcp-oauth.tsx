import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconCheck, IconExternalLink, IconX } from "@tabler/icons-react";
import { Dialog, DotMatrix, cn } from "@openedbot/browser-ui-kit";
import type { RuntimeMcpOauthDto } from "@openedbot/contracts-api";
import { ApiError, api, queryKeys } from "../../../../lib/api";
import { useT, type MessageKey } from "../../../../lib/i18n";
import { BUTTON, Note } from "../../../../components/settings/primitives";
import { useMcpLiveReload } from "../../../../lib/runtime/mcp-live-reload";

/**
 * A server's OAuth authorization, in a box of its own.
 *
 * Opening the box STARTS the authorization on the host: it is the host that discovers
 * the provider, registers its client and generates the URL; this browser only
 * opens it in a tab, then waits. The provider's return
 * goes through the API, never through this component, and the session becomes
 * « connectée » only when the host has reread a token on its disk and listed the
 * tools with it. Nothing secret ever arrives here.
 */
/**
 * What connects to what, when the authorization serves ONE bot: the service and the
 * bot, each with its face. The box shows them side by side, joined by a
 * line that carries the state (waiting, linked, broken).
 */
export type McpOauthPairing = {
  service: { name: string; logo: ReactNode };
  bot: { name: string; face: ReactNode };
};

/** What starts an authorization; `replacePending` cancels the one in progress for this server first. */
export type McpOauthStart = (server: string, options: { replacePending: boolean }) => Promise<RuntimeMcpOauthDto>;

type StartVariables = { server: string; replacePending: boolean; generation: number };

/** Poll failures retried before the box says the follow-up is interrupted (the host may still be going). */
const POLL_RETRIES = 3;
const POLL_INTERVAL_MS = 1_500;

/** The host no longer knows this session (expired, host restarted): only a new one can follow. */
function isSessionGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Another authorization holds this server: another bot's, another tab's, or one an older host does not attribute. */
function isPendingConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === "MCP_OAUTH_IN_PROGRESS";
}

/** A failure on the way (API, link or host unreachable, timeout): trying again can work. */
function isTransient(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

/** The other authorization was just approved and is completing: in a moment, the server is free. */
function isOtherCompleting(error: unknown): boolean {
  return error instanceof ApiError && error.code === "OAUTH_CALLBACK_RECEIVED";
}

/**
 * May the box cancel this session on its own (closed, unmounted, superseded)?
 * Only while it waits for the person AND the host says that no callback has
 * arrived. After the callback the host is completing an approval, which a
 * cancel would undo; an older host does not say (`null`) and accepts any
 * cancel, so the box leaves it alone: « Annuler » stays the explicit gesture,
 * and a leftover session comes back as a conflict with its way out.
 */
function autoCancellable(view: RuntimeMcpOauthDto | null | undefined): view is RuntimeMcpOauthDto {
  return Boolean(view)
    && (view!.status === "starting" || view!.status === "pending")
    && view!.callbackReceived === false;
}

type Followed = { server: string; view: RuntimeMcpOauthDto };

export function McpOauthDialog({
  server,
  title,
  pairing,
  start: startSession,
  onClose,
  onConnected,
}: {
  server: string | null;
  /** The displayed name, when it differs from the server's name on the host. */
  title?: string;
  /** Present for a connection to a bot: the service ↔ bot header replaces the general explanation. */
  pairing?: McpOauthPairing;
  /**
   * What opens the authorization. By default the runtime root's;
   * a bot's panel passes the catalog connection, for its profile.
   */
  start?: McpOauthStart;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t, formatNumber } = useT();
  const liveReload = useMcpLiveReload(server !== null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /**
   * Which opening of the box a start belongs to. Closing the box, unmounting
   * it, or starting again moves it on: a session that arrives for an older
   * one is an orphan, abandoned on the host (`autoCancellable`) instead of
   * staying pending, where it would hold the server and receive the next
   * person's authorization. Never the session the box follows: a start for
   * the same bot resumes the one in progress, which an older start may also
   * return; orphans therefore wait until the current start has answered.
   */
  const generationRef = useRef(0);
  const startInFlightRef = useRef(false);
  const followedRef = useRef<Followed | null>(null);
  const orphansRef = useRef<Followed[]>([]);
  const abandon = (name: string, id: string) => {
    // Best effort: a cancellation that does not get through leaves the session
    // to expire on the host, and the next start meets it as an explicit
    // conflict, with its way out, never as its own.
    void api.cancelRuntimeMcpOauth(name, id).catch(() => undefined);
  };
  const settleOrphans = () => {
    if (startInFlightRef.current) return;
    const followed = followedRef.current?.view.sessionId;
    for (const orphan of orphansRef.current.splice(0)) {
      if (orphan.view.sessionId !== followed && autoCancellable(orphan.view)) abandon(orphan.server, orphan.view.sessionId);
    }
  };
  /** The box stops following: what it followed is given up, under the same rule. */
  const relinquish = () => {
    generationRef.current += 1;
    startInFlightRef.current = false;
    const followed = followedRef.current;
    followedRef.current = null;
    if (followed && autoCancellable(followed.view)) abandon(followed.server, followed.view.sessionId);
    settleOrphans();
  };
  const start = useMutation({
    mutationFn: ({ server: name, replacePending }: StartVariables) =>
      (startSession ?? ((target, options) => api.startRuntimeMcpOauth(target, options)))(name, { replacePending }),
    onSuccess: (session, { server: name, generation }) => {
      if (generation !== generationRef.current) {
        orphansRef.current.push({ server: name, view: session });
        settleOrphans();
        return;
      }
      startInFlightRef.current = false;
      followedRef.current = { server: name, view: session };
      setSessionId(session.sessionId);
      settleOrphans();
    },
    onError: (_error, { generation }) => {
      if (generation !== generationRef.current) return;
      startInFlightRef.current = false;
      settleOrphans();
    },
  });
  const launch = (name: string, replacePending: boolean) => {
    generationRef.current += 1;
    startInFlightRef.current = true;
    followedRef.current = null;
    setSessionId(null);
    start.mutate({ server: name, replacePending, generation: generationRef.current });
  };
  const begin = (replacePending: boolean) => {
    if (server !== null) launch(server, replacePending);
  };
  const notifiedRef = useRef<string | null>(null);
  /**
   * The state lives ABOVE the box, not in its body: the actions are
   * CTAs, and a CTA lives in the `.bottomBar` foot, outside the scroll,
   * like an iOS toolbar. A child component could not place them
   * there.
   *
   * Hence this start driven by an effect rather than by a remount (`key`):
   * opening the box starts a session, reopening one must start a
   * new one, and closing must reset NOTHING while the sheet is still
   * sliding, otherwise the body empties under the eyes during the animation.
   */
  const startedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (server === null) {
      startedForRef.current = null;
      return;
    }
    if (startedForRef.current === server) return;
    startedForRef.current = server;
    notifiedRef.current = null;
    launch(server, false);
  }, [server, start]);
  /**
   * Unmounted without being closed (the page left): the session is given up
   * like on a close. Deferred, because React's development double mount runs
   * this cleanup and remounts at once; only a real unmount gives it up.
   */
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!mountedRef.current) relinquish();
      }, 0);
    };
    // Mount and unmount only: `relinquish` reads refs.
  }, []);
  const session = useQuery({
    queryKey: queryKeys.runtimeMcpOauth(server ?? "none", sessionId ?? "none"),
    queryFn: () => api.runtimeMcpOauth(server!, sessionId!),
    // Box closed: no more probe. The cache keeps the last state for as long as
    // the sheet takes to finish leaving.
    enabled: server !== null && Boolean(sessionId),
    // A failed poll is not the end of the authorization, which goes on on the
    // host: a few are retried, only a session the host no longer knows is lost.
    retry: (failures, error) => !isSessionGone(error) && failures < POLL_RETRIES,
    retryDelay: POLL_INTERVAL_MS,
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      const state = query.state.data?.status;
      return state === "starting" || state === "pending" ? POLL_INTERVAL_MS : false;
    },
  });
  const sessionGone = isSessionGone(session.error);
  const followInterrupted = session.error !== null && !sessionGone;
  const conflict = isPendingConflict(start.error);
  const current: RuntimeMcpOauthDto | undefined = sessionGone ? undefined : session.data ?? start.data;
  const cancel = useMutation({ mutationFn: () => api.cancelRuntimeMcpOauth(server!, sessionId!) });
  useEffect(() => {
    const followed = followedRef.current;
    if (current && followed?.view.sessionId === current.sessionId) followedRef.current = { server: followed.server, view: current };
  }, [current]);
  useEffect(() => {
    if (current?.status !== "connected" || notifiedRef.current === current.sessionId) return;
    notifiedRef.current = current.sessionId;
    onConnected();
  }, [current, onConnected]);

  const waiting = current?.status === "starting" || current?.status === "pending";
  // The provider's callback reached the host: it is completing the approval.
  const completing = waiting && current?.callbackReceived === true;
  /**
   * Closing the box, by its foot, its cross or Escape, ends what it started:
   * a session still waiting for the person is cancelled on the host, and a
   * start still on its way will be on arrival (`generationRef`), both under
   * `autoCancellable`.
   */
  const close = () => {
    relinquish();
    onClose();
  };
  const retryable = current?.status === "failed"
    || current?.status === "cancelled"
    || sessionGone
    || (start.error !== null && !conflict && (isTransient(start.error) || isOtherCompleting(start.error)));
  // The name survives the close for as long as the sheet slides: a title
  // emptied at once is more noticeable than the sheet itself.
  const lastServerRef = useRef<string | null>(null);
  if (server !== null) lastServerRef.current = title ?? server;
  const shown = server !== null ? (title ?? server) : lastServerRef.current;
  return (
    <Dialog
      open={server !== null}
      onClose={close}
      title={shown ?? ""}
      closeLabel={t("common.close")}
      footer={
        <>
          {waiting && sessionId && !completing ? (
            <button type="button" className={BUTTON.secondary} disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              {t("common.cancel")}
            </button>
          ) : (
            <button type="button" className={BUTTON.secondary} onClick={close}>{t("common.close")}</button>
          )}
          {conflict ? (
            <button type="button" className={BUTTON.primary} disabled={start.isPending} onClick={() => begin(true)}>
              {t("connectorsSettings.mcpOauthReplace")}
            </button>
          ) : followInterrupted ? (
            <button type="button" className={BUTTON.primary} disabled={session.isFetching} onClick={() => void session.refetch()}>
              {t("connectorsSettings.mcpOauthResume")}
            </button>
          ) : retryable ? (
            <button type="button" className={BUTTON.primary} disabled={start.isPending} onClick={() => begin(false)}>
              {t("connectorsSettings.mcpOauthRetry")}
            </button>
          ) : current?.status === "pending" && current.authorizationUrl ? (
            /* The sheet's CTA: the provider's tab. A link, because
               it is a navigation, but set in the bottom bar, not
               in the scroll. */
            <a className={BUTTON.primary} href={current.authorizationUrl} target="_blank" rel="noreferrer">
              {pairing ? t("connectorsPage.oauthOpen", { name: pairing.service.name }) : t("connectorsSettings.mcpOauthOpen")}
              <IconExternalLink aria-hidden className="size-4" />
            </a>
          ) : null}
        </>
      }
    >
      <div className="grid gap-3">
        {pairing ? (
          <>
            <PairingHeader
              pairing={pairing}
              state={conflict
                ? "idle"
                : (start.error && !start.isPending) || sessionGone || current?.status === "failed"
                  ? "broken"
                  : current?.status === "connected"
                    ? "linked"
                    : current?.status === "cancelled"
                      ? "idle"
                      : "waiting"}
            />
            <p className="text-center text-sm leading-6 text-muted-foreground text-balance">
              {t("connectorsPage.oauthBody", { name: pairing.service.name, bot: pairing.bot.name })}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpOauthTitle", { name: shown ?? "" })}</p>
            <p className="text-sm leading-6 text-muted-foreground">{t("connectorsSettings.mcpOauthDescription")}</p>
          </>
        )}
        {conflict ? (
          <Note tone="warning" role="alert">{t("connectorsSettings.mcpOauthConflict")}</Note>
        ) : isOtherCompleting(start.error) ? (
          <Note tone="warning" role="alert">{t("connectorsSettings.mcpOauthOtherCompleting")}</Note>
        ) : start.error ? (
          <Note tone="danger" role="alert">{start.error instanceof Error ? start.error.message : t("connectorsSettings.mcpOauthFailed")}</Note>
        ) : isOtherCompleting(cancel.error) || completing ? (
          <p role="status" className={cn("flex items-center gap-2 text-sm text-muted-foreground", pairing && "justify-center")}>
            {pairing ? null : <DotMatrix aria-hidden state="connecting" label={t("connectorsSettings.mcpOauthCompleting")} />}
            {t("connectorsSettings.mcpOauthCompleting")}
          </p>
        ) : sessionGone ? (
          <Note tone="danger" role="alert">{t("connectorsSettings.mcpOauthSessionLost")}</Note>
        ) : followInterrupted ? (
          <Note tone="warning" role="alert">{t("connectorsSettings.mcpOauthPollInterrupted")}</Note>
        ) : !current || current.status === "starting" ? (
          <p role="status" className={cn("flex items-center gap-2 text-sm text-muted-foreground", pairing && "justify-center")}>
            {pairing ? null : <DotMatrix aria-hidden state="connecting" label={t("connectorsSettings.mcpOauthPreparing")} />}
            {t("connectorsSettings.mcpOauthPreparing")}
          </p>
        ) : current.status === "pending" ? (
          <p role="status" className={cn("flex items-center gap-2 text-sm text-muted-foreground", pairing && "justify-center")}>
            {pairing ? null : <DotMatrix aria-hidden state="waiting" label={t("connectorsSettings.mcpOauthWaiting")} />}
            {t("connectorsSettings.mcpOauthWaiting")}
          </p>
        ) : current.status === "connected" ? (
          <div className="grid gap-2">
            <Note tone="success" role="status">
              {current.discoveredTools.length > 0
                ? t("connectorsSettings.mcpOauthConnected", { count: formatNumber(current.discoveredTools.length) })
                : t("connectorsSettings.mcpOauthConnectedNoTools")}
            </Note>
            <Note tone="info">{t(liveReload ? "connectorsSettings.mcpOauthLiveHint" : "connectorsSettings.mcpOauthRestartHint")}</Note>
          </div>
        ) : current.status === "cancelled" ? (
          <Note tone="neutral">{t("connectorsSettings.mcpOauthCancelled")}</Note>
        ) : (
          <Note tone="danger" role="alert">{t(oauthErrorKey(current.errorCode))}</Note>
        )}
      </div>
    </Dialog>
  );
}

/**
 * A failure's message, by its code: never the host's text, which is in
 * English and describes the implementation rather than what the person can do.
 */
function oauthErrorKey(code: string | null | undefined): MessageKey {
  switch (code) {
    case "OAUTH_TIMEOUT": return "connectorsSettings.mcpOauthErrorTimeout";
    case "OAUTH_CALLBACK_INVALID": return "connectorsSettings.mcpOauthErrorCallback";
    case "OAUTH_REGISTRATION_REFUSED": return "connectorsSettings.mcpOauthErrorRegistration";
    case "OAUTH_NO_TOKEN": return "connectorsSettings.mcpOauthErrorNoToken";
    case "PROFILE_NOT_FOUND": return "connectorsSettings.mcpOauthErrorProfile";
    default: return "connectorsSettings.mcpOauthFailed";
  }
}

type PairingState = "waiting" | "linked" | "broken" | "idle";

/**
 * The service on the left, the bot on the right, and between them the connection's line:
 * dotted and animated while the authorization waits, solid and checked once
 * the token is proved, cut with a cross if it fails. It is the only marked
 * element of the box; everything else stays quiet.
 */
function PairingHeader({ pairing, state }: { pairing: McpOauthPairing; state: PairingState }) {
  const line = state === "linked"
    ? "border-t-2 border-solid border-pos-700/70"
    : state === "broken"
      ? "border-t-2 border-dashed border-destructive/50"
      : "border-t-2 border-dashed border-border";
  return (
    <div data-oauth-pairing={state} className="flex items-center justify-center gap-3 pt-1 pb-2">
      <PairingSide label={pairing.service.name}>{pairing.service.logo}</PairingSide>
      <div aria-hidden className="relative flex w-24 items-center justify-center">
        <span className={cn("absolute inset-x-0 top-1/2", line)} />
        <span className="relative flex size-7 items-center justify-center rounded-full border border-border bg-card">
          {state === "linked" ? (
            <IconCheck className="size-4 text-pos-700" />
          ) : state === "broken" ? (
            <IconX className="size-4 text-destructive-text" />
          ) : state === "waiting" ? (
            <DotMatrix state="waiting" label="" />
          ) : null}
        </span>
      </div>
      <PairingSide label={pairing.bot.name}>{pairing.bot.face}</PairingSide>
    </div>
  );
}

function PairingSide({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex w-20 flex-col items-center gap-1.5">
      <span className="flex size-12 items-center justify-center [&>[data-connector-logo]]:size-12 [&>[data-connector-logo]]:rounded-xl [&>[data-connector-logo]>svg]:size-6">
        {children}
      </span>
      <span className="max-w-full truncate text-xs font-medium text-foreground">{label}</span>
    </span>
  );
}
