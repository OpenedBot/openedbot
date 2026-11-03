import { open } from "node:fs/promises";
import { renderTransactionalEmail } from "../../modules/notifications/src/domain/email/templates";

const SIGN_IN_SUBJECTS = new Set([
  renderTransactionalEmail({ kind: "email_login_code", locale: "fr", data: { code: "000000" } }).subject,
  renderTransactionalEmail({ kind: "email_login_code", locale: "en", data: { code: "000000" } }).subject,
]);

const DEFAULT_MAILBOX_URL = "http://127.0.0.1:8025";
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 15_000;
// The API answers 202 without a new mail while the previous code is open and
// under its 60 s cooldown (modules/identity email-login-code.ts), so the whole
// cooldown is the reuse window. An older code was replaced, and mailed again.
const FALLBACK_AGE_MS = 60_000;

type MailpitMessage = {
  ID?: unknown;
  id?: unknown;
  Created?: unknown;
  created?: unknown;
  Subject?: unknown;
  subject?: unknown;
  To?: unknown;
  to?: unknown;
  Text?: unknown;
  text?: unknown;
};

type MailpitSearchResponse = { messages?: MailpitMessage[] };

class MailpitTimeoutError extends Error {}

function mailboxOrigin(value?: string): string {
  return (value?.trim() || process.env.E2E_MAILPIT_URL?.trim()
    || process.env.TRANSACTIONAL_EMAIL_MAILBOX_URL?.trim() || DEFAULT_MAILBOX_URL).replace(/\/+$/u, "");
}

function visibleMailboxUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value;
  }
}

function messageId(message: MailpitMessage): string | null {
  const id = message.ID ?? message.id;
  return typeof id === "string" && id ? id : null;
}

function messageCreatedAt(message: MailpitMessage): number | null {
  const created = message.Created ?? message.created;
  if (typeof created !== "string" && typeof created !== "number") return null;
  const timestamp = typeof created === "number" ? created : Date.parse(created);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toAddresses(message: MailpitMessage): string[] {
  const recipients = message.To ?? message.to;
  if (!Array.isArray(recipients)) return [];
  return recipients.flatMap((recipient) => {
    if (!recipient || typeof recipient !== "object") return [];
    const address = (recipient as { Address?: unknown; address?: unknown }).Address
      ?? (recipient as { address?: unknown }).address;
    return typeof address === "string" ? [address.trim()] : [];
  });
}

function hasExpectedSubject(message: MailpitMessage): boolean {
  const subject = message.Subject ?? message.subject;
  return typeof subject === "string" && SIGN_IN_SUBJECTS.has(subject);
}

function codeFromText(message: MailpitMessage): string | null {
  const text = message.Text ?? message.text;
  if (typeof text !== "string") return null;
  return /^Code\s*:\s*(\d{6})\b/mu.exec(text)?.[1] ?? null;
}

function matchesAddress(message: MailpitMessage, email: string): boolean {
  const expected = email.trim().toLowerCase();
  return toAddresses(message).some((address) => address.toLowerCase() === expected);
}

async function fetchSearch(email: string, url: string, signal?: AbortSignal): Promise<MailpitMessage[]> {
  const query = `to:"${email}"`;
  const response = await fetch(`${url}/api/v1/search?query=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) throw new Error(`Mailpit search for ${email} failed with HTTP ${response.status} at ${visibleMailboxUrl(url)}.`);
  const body = await response.json() as MailpitSearchResponse;
  return Array.isArray(body.messages) ? body.messages : [];
}

async function fetchMessage(id: string, email: string, url: string, signal?: AbortSignal): Promise<MailpitMessage> {
  const response = await fetch(`${url}/api/v1/message/${encodeURIComponent(id)}`, { signal });
  if (!response.ok) throw new Error(`Mailpit message lookup for ${email} failed with HTTP ${response.status} at ${visibleMailboxUrl(url)}.`);
  const body = await response.json() as MailpitMessage | { Message?: MailpitMessage };
  return "Message" in body && body.Message ? body.Message : body as MailpitMessage;
}

async function matchingCodes(
  email: string,
  messages: MailpitMessage[],
  url: string,
  signal?: AbortSignal,
): Promise<Array<{ id: string; createdAt: number | null; code: string }>> {
  const candidates = messages
    .map((message, index) => ({ message, index, id: messageId(message), createdAt: messageCreatedAt(message) }))
    .filter((entry): entry is typeof entry & { id: string } => Boolean(entry.id))
    .sort((a, b) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity) || b.index - a.index);
  const found: Array<{ id: string; createdAt: number | null; code: string }> = [];
  for (const candidate of candidates) {
    const hasToMetadata = Array.isArray(candidate.message.To ?? candidate.message.to);
    const hasSubjectMetadata = typeof (candidate.message.Subject ?? candidate.message.subject) === "string";
    if (hasToMetadata && !matchesAddress(candidate.message, email)) continue;
    if (hasSubjectMetadata && !hasExpectedSubject(candidate.message)) continue;
    const full = await fetchMessage(candidate.id, email, url, signal);
    if (!matchesAddress(full, email) || !hasExpectedSubject(full)) continue;
    const code = codeFromText(full);
    if (code) found.push({ id: candidate.id, createdAt: messageCreatedAt(full) ?? candidate.createdAt, code });
  }
  return found;
}

export async function listMailpitMessageIds(
  email: string,
  options: { mailboxUrl?: string; signal?: AbortSignal } = {},
): Promise<Set<string>> {
  const url = mailboxOrigin(options.mailboxUrl);
  const messages = await fetchSearch(email, url, options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS));
  return new Set(messages.map(messageId).filter((id): id is string => id !== null));
}

export async function readMailpitLoginCode(
  email: string,
  options: {
    knownIds: ReadonlySet<string>;
    mailboxUrl?: string;
    since?: number;
    timeoutMs?: number;
    fallback?: boolean;
    signal?: AbortSignal;
  },
): Promise<string> {
  const url = mailboxOrigin(options.mailboxUrl);
  const since = options.since ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const pollSignal = options.signal ?? AbortSignal.timeout(timeoutMs);
  while (Date.now() < deadline) {
    if (pollSignal.aborted && pollSignal.reason?.name !== "TimeoutError") throw pollSignal.reason;
    let messages: MailpitMessage[];
    try {
      messages = await fetchSearch(email, url, pollSignal);
      const fresh = messages.filter((message) => {
        const id = messageId(message);
        const createdAt = messageCreatedAt(message);
        return id !== null && !options.knownIds.has(id) && (createdAt === null || createdAt >= since);
      });
      const candidates = await matchingCodes(email, fresh, url, pollSignal);
      if (candidates.length) return candidates[0]!.code;
    } catch (error) {
      if (pollSignal.aborted && pollSignal.reason?.name === "TimeoutError") break;
      throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }

  if (options.fallback) {
    if (pollSignal.aborted && pollSignal.reason?.name !== "TimeoutError") throw pollSignal.reason;
    const fallbackSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const messages = await fetchSearch(email, url, fallbackSignal);
    const fallbackMessages = messages.filter((message) => {
      const createdAt = messageCreatedAt(message);
      return createdAt !== null && createdAt <= since && since - createdAt <= FALLBACK_AGE_MS;
    });
    const candidates = await matchingCodes(email, fallbackMessages, url, fallbackSignal);
    if (candidates.length) return candidates[0]!.code;
  }

  throw new MailpitTimeoutError(`Timed out waiting for a sign-in code for ${email} at ${visibleMailboxUrl(url)}.`);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function canReadMailpit(apiUrl: string): boolean {
  if (process.env.E2E_MAILPIT_URL?.trim()) return true;
  try {
    return isLoopbackHostname(new URL(apiUrl).hostname);
  } catch {
    return false;
  }
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function readTTYLine(prompt: string): Promise<string> {
  const tty = await open("/dev/tty", "r+");
  let echoDisabled = false;
  try {
    await tty.write(prompt);
    const disabled = await Bun.spawn(["stty", "-echo"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
    if (disabled !== 0) throw new Error("Could not disable terminal echo while reading the sign-in code.");
    echoDisabled = true;
    const bytes = Buffer.alloc(1);
    let line = "";
    while (line.length < 128) {
      const { bytesRead } = await tty.read(bytes, 0, 1, null);
      if (!bytesRead || bytes[0] === 10 || bytes[0] === 13) break;
      line += bytes.toString("utf8", 0, bytesRead);
    }
    return line;
  } finally {
    if (echoDisabled) {
      await Bun.spawn(["stty", "echo"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
      await tty.write("\n");
    }
    await tty.close();
  }
}

async function promptForCode(email: string): Promise<string> {
  if (!isInteractive()) {
    throw new Error(`A sign-in code was sent by email to ${email}; this target needs an interactive run.`);
  }
  const code = await readTTYLine(`Sign-in code for ${email}: `);
  if (!/^\d{6}$/u.test(code)) throw new Error(`The sign-in code for ${email} must contain exactly six digits.`);
  return code;
}

type PasswordLoginOptions = {
  path?: "/api/auth/login" | "/api/auth/native/authorize";
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
  onCode?: (code: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export async function passwordLogin(
  baseUrl: string,
  body: Record<string, unknown> & { email: string; password: string },
  init: PasswordLoginOptions = {},
): Promise<Response> {
  const url = baseUrl.replace(/\/+$/u, "");
  const path = init.path ?? "/api/auth/login";
  const mailboxEnabled = canReadMailpit(url);
  const mailboxUrl = process.env.E2E_MAILPIT_URL?.trim() || process.env.TRANSACTIONAL_EMAIL_MAILBOX_URL?.trim() || DEFAULT_MAILBOX_URL;
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const redirect = init.redirect ?? "error";
  const sleep = init.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let firstPost = true;

  const post = async (
    payload: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<{ response: Response; since: number; knownIds: Set<string> }> => {
    const serializedBody = JSON.stringify(payload);
    const knownIds = mailboxEnabled
      ? await listMailpitMessageIds(body.email, { mailboxUrl, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) })
      : new Set<string>();
    const signal = callerSignal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const requestInit: RequestInit = {
      method: "POST",
      headers,
      body: serializedBody,
      redirect,
      signal,
    };
    const since = Date.now();
    const response = await fetch(`${url}${path}`, requestInit);
    firstPost = false;
    return { response, since, knownIds };
  };

  const runFlow = async (allowFallback: boolean): Promise<Response> => {
    const firstRequest = await post({ ...body }, firstPost ? init.signal : undefined);
    const response = firstRequest.response;
    if (response.status !== 202) return response;
    const parsed = await response.clone().json().catch(() => null) as { status?: unknown } | null;
    if (parsed?.status !== "code_required") return response;

    let code: string;
    if (!mailboxEnabled) {
      code = await promptForCode(body.email);
    } else {
      try {
        code = await readMailpitLoginCode(body.email, {
          knownIds: firstRequest.knownIds,
          mailboxUrl,
          since: firstRequest.since,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          fallback: allowFallback,
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        if (!(error instanceof MailpitTimeoutError) || !isInteractive()) throw error;
        code = await promptForCode(body.email);
      }
    }
    init.onCode?.(code);
    return (await post({ ...body, emailCode: code })).response;
  };

  const firstResponse = await runFlow(true);
  if (firstResponse.status !== 429) return firstResponse;
  const errorBody = await firstResponse.clone().json().catch(() => null) as { error?: { code?: unknown } } | null;
  if (errorBody?.error?.code !== "EMAIL_LOGIN_CODE_COOLDOWN") return firstResponse;

  await sleep(61_000);
  return runFlow(false);
}
