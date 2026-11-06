// Sign in to the LOCAL dev API for the D0 measurements (apps/console/scripts/perf/d0-baseline.ts).
//
// The password comes from the env file given by the caller and never leaves
// this process: it is not logged, not written to disk, not passed on argv.
// The e-mail code is read from Mailpit, like a person would read their inbox.

import { readFileSync } from "node:fs";

export type WebSession = {
  /** `Cookie` header value for the API. */
  cookieHeader: string;
  /** Cookies in Playwright's shape, scoped to the console host. */
  cookies: Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: "Lax" | "Strict" | "None" }>;
  /** `localStorage["openedbot:cloud-session"]`, what the console's login screen stores. */
  cloudSession: { organizationId: string; csrfToken: string; userId: string };
};

export function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match) values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/u, "$2");
  }
  return values;
}

const MAILPIT = "http://localhost:8025";

// Two sign-ins a second apart (the web one, then Electron's) send two codes:
// a message already read is never read again, or the second sign-in would
// replay the first, consumed code.
const consumedMessages = new Set<string>();

/** Newest e-mail code sent to `email` after `since` (Mailpit) and not read before, polled for up to 20 s. */
export async function readMailpitCode(email: string, since: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  // One signal per request covers its body too: a stalled Mailpit cannot
  // hold the sign-in past the deadline.
  const bounded = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  while (Date.now() < deadline) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=5`, { signal: bounded() })).json() as {
      messages?: Array<{ ID: string; Created: string }>;
    };
    for (const message of list.messages ?? []) {
      if (consumedMessages.has(message.ID) || Date.parse(message.Created) < since - 1_000) continue;
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`, { signal: bounded() })).json() as { Text?: string };
      const code = /\b(\d{6})\b/u.exec(full.Text ?? "")?.[1];
      if (code) {
        consumedMessages.add(message.ID);
        return code;
      }
    }
    await Bun.sleep(400);
  }
  throw new Error(`no e-mail code reached Mailpit for ${email} within 20 s`);
}

function setCookies(response: Response): Array<[string, string]> {
  return response.headers.getSetCookie().map((line) => {
    const [pair] = line.split(";");
    const index = pair!.indexOf("=");
    return [pair!.slice(0, index).trim(), pair!.slice(index + 1).trim()];
  });
}

/** Password + e-mail code, the console's own web login (`POST /api/auth/login`). */
export async function signInWeb(apiBase: string, consoleHost: string, envFile: string): Promise<WebSession> {
  const env = readEnvFile(envFile);
  const email = env.E2E_EMAIL;
  const password = env.E2E_PASSWORD;
  if (!email || !password) throw new Error(`E2E_EMAIL and E2E_PASSWORD must be set in ${envFile}`);
  const post = (body: Record<string, string>) => fetch(`${apiBase}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept-language": "fr" },
    body: JSON.stringify(body),
  });
  const since = Date.now();
  const first = await post({ email, password });
  if (first.status !== 202) throw new Error(`login step 1 answered ${first.status}`);
  const code = await readMailpitCode(email, since);
  const second = await post({ email, password, emailCode: code });
  if (!second.ok) throw new Error(`login step 2 answered ${second.status}`);
  const body = await second.json() as { csrfToken: string; organizationId: string; user: { id: string } };
  const jar = setCookies(second);
  return {
    cookieHeader: jar.map(([name, value]) => `${name}=${value}`).join("; "),
    cookies: jar.map(([name, value]) => ({ name, value, domain: consoleHost, path: "/", httpOnly: true, secure: false, sameSite: "Lax" as const })),
    cloudSession: { organizationId: body.organizationId, csrfToken: body.csrfToken, userId: body.user.id },
  };
}

export async function signOutWeb(apiBase: string, session: WebSession): Promise<void> {
  await fetch(`${apiBase}/api/auth/logout`, {
    method: "POST",
    headers: { cookie: session.cookieHeader, "x-csrf-token": session.cloudSession.csrfToken },
  });
}

export function e2eEmail(envFile: string): string {
  const email = readEnvFile(envFile).E2E_EMAIL;
  if (!email) throw new Error(`E2E_EMAIL must be set in ${envFile}`);
  return email;
}
