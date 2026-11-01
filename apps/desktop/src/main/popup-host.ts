import { app } from "electron";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  encodeHostMessage,
  LineSplitter,
  parsePopupMessage,
  POPUP_PROTOCOL_VERSION,
  RequestLedger,
  resolveConsolePath,
  type HostToPopup,
  type PopupToHost,
} from "../shared/popup-protocol";
import type { AuthService } from "./auth";
import type { DesktopConfig } from "./config";
import { log } from "./log";

// The popup is openedbot Notch (OpenedBot/openedbot-notch, its own repository),
// embedded as a built bundle and never as source. We run its executable directly as a child with `--hosted` and
// talk over stdin/stdout (src/shared/popup-protocol.ts): a private channel with
// no socket to authenticate, and the popup's life is tied to ours (EOF on its
// stdin makes it quit, even if we crash).

const BUNDLE_NAME = "OHBPopup.app";
const EXECUTABLE = path.join("Contents", "MacOS", "OHBPopup");
/** The popup announces itself right after launch; silence past this is a hung start. */
const READY_TIMEOUT_MS = 10_000;
/** After asking it to stop (stdin closed), the popup gets this long before SIGTERM. */
const STOP_GRACE_MS = 2_000;
/** Consecutive failed runs before giving up (and falling back to the window). */
const MAX_FAILURES = 5;
const RESTART_BASE_MS = 1_000;
const RESTART_CAP_MS = 16_000;
/** A run that lasted this long after `ready` was healthy: the failure count starts over. */
const HEALTHY_RUN_MS = 60_000;

export type PopupGiveUpReason =
  | { kind: "missing" }
  | { kind: "crashing"; failures: number }
  | { kind: "protocol"; version: number }
  | { kind: "fatal"; code: string };

export type PopupHostDeps = {
  config: DesktopConfig;
  auth: AuthService;
  /** `openConsole` from the popup, already resolved to a console URL. */
  onOpenConsole(url: string): void;
  /** The popup cannot run (bundle missing, crash loop, refused): fall back to the window. */
  onGiveUp(reason: PopupGiveUpReason): void;
  /** The user quit the popup from its own menu (clean exit we did not ask for). */
  onUserClosed(): void;
};

export type PopupHost = {
  /** Keeps a popup running from now on (idempotent). */
  start(): void;
  /** Stops it and keeps it stopped (idempotent). */
  stop(): void;
  notifySignedIn(): void;
  notifySignedOut(): void;
};

/**
 * The popup bundle: next to the app when packaged (Contents/Helpers, see
 * electron-builder.yml), otherwise OPENEDBOT_POPUP_APP or the build of an
 * openedbot-notch checkout next to this repository (`make bundle` there).
 * null when none has the executable.
 */
export function locatePopupBundle(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "..", "Helpers", BUNDLE_NAME)]
    : [process.env.OPENEDBOT_POPUP_APP?.trim(), path.resolve(app.getAppPath(), "..", "..", "..", "openedbot-notch", "dist", BUNDLE_NAME)];
  for (const candidate of candidates) {
    if (candidate && existsSync(path.join(candidate, EXECUTABLE))) return candidate;
  }
  return null;
}

/** stdin and stdout are the protocol; stderr is inherited (null here). */
type PopupProcess = ChildProcessByStdio<Writable, Readable, null>;

/**
 * The host protocol a bundle declares (`OHBHostedProtocol` in its Info.plist,
 * written as XML by `make bundle` in openedbot-notch). null when absent: a build
 * from before hosted mode, which would ignore --hosted and start on its own
 * (its own sign-in, its own Keychain) instead of talking to us.
 */
export function readHostedProtocol(bundle: string): number | null {
  try {
    const plist = readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
    const match = /<key>OHBHostedProtocol<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

type Run = {
  process: PopupProcess;
  ready: boolean;
  readyAt: number | null;
  /** We closed its stdin on purpose: its exit is not a failure. */
  stopping: boolean;
  /** It said `fatal` or spoke another protocol: do not restart. */
  refusal: PopupGiveUpReason | null;
  ledger: RequestLedger;
  /** The last access token handed to this popup (see AuthService.readAccess). */
  servedToken: string | null;
  readyTimer: NodeJS.Timeout | null;
};

export function createPopupHost(deps: PopupHostDeps): PopupHost {
  const { config, auth } = deps;
  let wanted = false;
  let run: Run | null = null;
  let failures = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  function send(current: Run, message: HostToPopup): void {
    if (run !== current || !current.process.stdin.writable) return;
    try {
      current.process.stdin.write(encodeHostMessage(message));
    } catch (error) {
      log.warn(`popup channel write failed (${error instanceof Error ? error.message : "error"})`);
    }
  }

  function giveUp(reason: PopupGiveUpReason): void {
    wanted = false;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    log.error(`popup disabled: ${reason.kind}${reason.kind === "fatal" ? ` ${reason.code}` : ""}`);
    deps.onGiveUp(reason);
  }

  function launch(): void {
    restartTimer = null;
    if (!wanted || run) return;
    const bundle = locatePopupBundle();
    if (!bundle) {
      giveUp({ kind: "missing" });
      return;
    }
    const declared = readHostedProtocol(bundle);
    if (declared !== POPUP_PROTOCOL_VERSION) {
      giveUp({ kind: "protocol", version: declared ?? 0 });
      return;
    }
    let child: PopupProcess;
    try {
      // stderr is inherited: the popup's own logs (os_log, stderr) never touch the protocol.
      child = spawn(path.join(bundle, EXECUTABLE), ["--hosted"], { stdio: ["pipe", "pipe", "inherit"] });
    } catch (error) {
      log.error("popup spawn failed", error);
      onFailure();
      return;
    }
    const current: Run = {
      process: child,
      ready: false,
      readyAt: null,
      stopping: false,
      refusal: null,
      ledger: new RequestLedger(),
      servedToken: null,
      readyTimer: null,
    };
    run = current;

    // A popup that died leaves a broken pipe: EPIPE on our next write must not
    // become an uncaught exception in the main process.
    child.stdin.on("error", (error) => log.warn(`popup stdin closed (${error.message})`));
    const splitter = new LineSplitter();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const { lines, overflowed } = splitter.push(chunk);
      if (overflowed > 0) log.warn(`popup line ignored (too long) x${overflowed}`);
      for (const line of lines) handleLine(current, line);
    });
    child.on("error", (error) => {
      // Spawn failure (EACCES, ENOENT): no "exit" may follow.
      log.error("popup process error", error);
      onExit(current, null, null);
    });
    child.on("exit", (code, signal) => onExit(current, code, signal));
    current.readyTimer = setTimeout(() => {
      current.readyTimer = null;
      if (run === current && !current.ready) {
        log.error("popup never sent ready: stopping it");
        child.kill("SIGTERM");
      }
    }, READY_TIMEOUT_MS);
    log.info(`popup started (${app.isPackaged ? "embedded" : bundle})`);
  }

  function handleLine(current: Run, line: string): void {
    if (run !== current) return;
    const parsed = parsePopupMessage(line);
    if (!parsed.ok) {
      // The reason only: the line itself may carry anything.
      log.warn(`popup line ignored (${parsed.reason})`);
      return;
    }
    const message: PopupToHost = parsed.message;
    if (!current.ready && message.type !== "ready" && message.type !== "fatal") {
      log.warn(`popup message before ready ignored (${message.type})`);
      return;
    }
    switch (message.type) {
      case "ready": {
        if (current.readyTimer) clearTimeout(current.readyTimer);
        current.readyTimer = null;
        if (message.protocol !== POPUP_PROTOCOL_VERSION) {
          log.error(`popup speaks protocol ${message.protocol}, expected ${POPUP_PROTOCOL_VERSION}: stopping it`);
          current.refusal = { kind: "protocol", version: message.protocol };
          current.process.kill("SIGTERM");
          return;
        }
        current.ready = true;
        current.readyAt = Date.now();
        log.info(`popup ready (version ${message.version})`);
        send(current, { type: "hello", protocol: POPUP_PROTOCOL_VERSION, apiOrigin: config.apiOrigin, consoleUrl: config.consoleUrl });
        send(current, { type: auth.isSignedIn() ? "signedIn" : "signedOut" });
        return;
      }
      case "token":
        if (!current.ledger.begin(message.id)) {
          log.warn("popup token request with an id already in flight ignored");
          return;
        }
        void serveToken(current, message.id, message.force);
        return;
      case "openConsole": {
        const url = resolveConsolePath(config.consoleUrl, message.path);
        if (!url) {
          log.warn("popup asked for a console path that is not allowed");
          return;
        }
        deps.onOpenConsole(url);
        return;
      }
      case "signOut":
        auth.signOut();
        return;
      case "fatal":
        log.error(`popup refused to run: ${message.code}`);
        current.refusal = { kind: "fatal", code: message.code };
        return;
    }
  }

  async function serveToken(current: Run, id: string, force: boolean): Promise<void> {
    try {
      const access = await auth.readAccess({ force, servedToken: current.servedToken });
      if (access) current.servedToken = access.accessToken;
      send(current, {
        type: "token",
        id,
        accessToken: access?.accessToken ?? null,
        expiresAt: access?.accessTokenExpiresAt ?? null,
        organizationId: access?.organizationId ?? null,
      });
    } catch (error) {
      // Network or 5xx: the session lives, the popup keeps its state and retries.
      log.warn(`token for the popup unavailable (${error instanceof Error ? error.message : "error"})`);
      send(current, { type: "token", id, accessToken: null, expiresAt: null, organizationId: null, error: "unavailable" });
    } finally {
      current.ledger.settle(id);
    }
  }

  function onExit(current: Run, code: number | null, signal: NodeJS.Signals | null): void {
    if (run !== current) return;
    run = null;
    if (current.readyTimer) clearTimeout(current.readyTimer);
    current.ledger.clear();
    log.info(`popup exited (${signal ?? `code ${code}`})`);
    if (current.stopping) {
      // Stopped, then wanted again before it was gone (mode switched back): start a fresh one.
      if (wanted) launch();
      return;
    }
    if (!wanted) return;
    if (current.refusal) {
      giveUp(current.refusal);
      return;
    }
    if (code === 0 && signal === null && current.ready) {
      // "Quit openedbot Notch" from its own menu: the user turned the popup off.
      wanted = false;
      deps.onUserClosed();
      return;
    }
    if (current.readyAt !== null && Date.now() - current.readyAt >= HEALTHY_RUN_MS) failures = 0;
    onFailure();
  }

  function onFailure(): void {
    failures += 1;
    if (failures > MAX_FAILURES) {
      giveUp({ kind: "crashing", failures: failures - 1 });
      return;
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** (failures - 1), RESTART_CAP_MS);
    log.warn(`popup failed (${failures}/${MAX_FAILURES}), restarting in ${delay} ms`);
    restartTimer = setTimeout(launch, delay);
  }

  return {
    start(): void {
      if (wanted) return;
      wanted = true;
      failures = 0;
      launch();
    },

    stop(): void {
      wanted = false;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      const current = run;
      if (!current) return;
      current.stopping = true;
      // EOF is the polite stop: the popup terminates on its own. SIGTERM only
      // if it is still there after the grace period (main thread stuck).
      current.process.stdin.end();
      const killer = setTimeout(() => {
        if (current.process.exitCode === null && current.process.signalCode === null) current.process.kill("SIGTERM");
      }, STOP_GRACE_MS);
      killer.unref();
    },

    notifySignedIn(): void {
      if (run?.ready) send(run, { type: "signedIn" });
    },

    notifySignedOut(): void {
      if (!run) return;
      run.servedToken = null;
      if (run.ready) send(run, { type: "signedOut" });
    },
  };
}
