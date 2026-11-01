import { passwordLogin } from "../../scripts/lib/password-login";

const baseUrl = (process.env.E2E_API_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
const email = process.env.E2E_EMAIL ?? "dev@ohb.local";
const password = process.env.E2E_PASSWORD || (() => { throw new Error("E2E_PASSWORD is not set: run `make setup` (it generates one in .env.local), or export it."); })();

const health = await fetch(`${baseUrl}/api/health`);
if (!health.ok) throw new Error(`Cloud health failed with HTTP ${health.status}.`);

const login = await passwordLogin(baseUrl, { email, password });
if (!login.ok) throw new Error(`Cloud login failed with HTTP ${login.status}: ${await login.text()}`);
const loginBody = await login.json() as { csrfToken: string; organizationId: string };
const setCookie = login.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(",").map((part) => part.trim().split(";")[0]).filter(Boolean).join("; ");
if (!cookie || !loginBody.csrfToken || !loginBody.organizationId) throw new Error("Cloud login did not return session cookies and organization.");

const headers = { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken, "X-OHB-Organization": loginBody.organizationId };
for (const path of ["/api/auth/me", "/api/bots", "/api/runtime", "/api/overview", "/api/inbox"]) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${await response.text()}`);
}

/**
 * Écran « Sécurité du compte » — lecture seule : aucun changement de mot de
 * passe ni révocation de session en e2e, seulement la forme de la réponse et
 * l'absence de toute clé secrète.
 */
const security = await fetch(`${baseUrl}/api/account/security`, { headers });
if (!security.ok) throw new Error(`/api/account/security failed with HTTP ${security.status}: ${await security.text()}`);
const securityBody = await security.json() as { method?: unknown; sessions?: unknown };
if (!securityBody.method || typeof securityBody.method !== "object") {
  throw new Error("/api/account/security did not return a method object.");
}
if (!Array.isArray(securityBody.sessions)) {
  throw new Error("/api/account/security did not return a sessions array.");
}
const currentSessions = securityBody.sessions.filter((row) => (row as { current?: unknown }).current === true);
if (currentSessions.length !== 1) {
  throw new Error(`/api/account/security returned ${currentSessions.length} current sessions, expected exactly one.`);
}
if (/hash|token|secret|csrf/i.test(JSON.stringify(securityBody))) {
  throw new Error("/api/account/security leaked a key matching hash/token/secret/csrf.");
}

const decisions = await fetch(`${baseUrl}/api/decisions`, { headers });
if (!decisions.ok) throw new Error(`/api/decisions failed with HTTP ${decisions.status}: ${await decisions.text()}`);
const decisionsBody = await decisions.json() as { decisions?: unknown };
if (!Array.isArray(decisionsBody.decisions)) {
  throw new Error("/api/decisions did not return a decisions array.");
}
for (const row of decisionsBody.decisions) {
  if (!row || typeof row !== "object") throw new Error("/api/decisions returned a non-object row.");
  const decision = row as Record<string, unknown>;
  for (const field of ["botName", "action", "kind", "choice", "issuedAt"]) {
    if (typeof decision[field] !== "string") {
      throw new Error(`/api/decisions is missing ${field} on a row.`);
    }
  }
}

const usage = await fetch(`${baseUrl}/api/usage`, { headers });
if (!usage.ok) throw new Error(`/api/usage failed with HTTP ${usage.status}: ${await usage.text()}`);
const usageBody = await usage.json() as Record<string, unknown>;
for (const granularity of ["day", "week", "month", "year"]) {
  if (!Array.isArray(usageBody[granularity])) throw new Error(`/api/usage did not return the "${granularity}" series.`);
}

const usageModels = await fetch(`${baseUrl}/api/usage/models`, { headers });
if (!usageModels.ok) throw new Error(`/api/usage/models failed with HTTP ${usageModels.status}: ${await usageModels.text()}`);
const usageModelsBody = await usageModels.json() as { windowDays?: unknown; models?: unknown };
if (usageModelsBody.windowDays !== 90 || !Array.isArray(usageModelsBody.models)) {
  throw new Error("/api/usage/models did not return a 90-day model breakdown.");
}

/**
 * Le rejeu SSE joint le contenu persisté à chaque événement TERMINAL
 * (`payload.completion`) : c'est ce bloc qui remplace le rechargement complet
 * du fil à la fin d'une génération, côté web comme côté client natif.
 *
 * Lecture seule, et bornée dans le temps : on ouvre `/api/events?cursor=0`,
 * on lit la fenêtre rejouée, et on referme. Rien n'est écrit, aucun run n'est
 * lancé — ce parcours ne dépend d'aucun runtime Hermes.
 *
 * Aucun run terminé dans la base seedée n'est pas un échec, mais ce n'est pas
 * une preuve non plus : le compteur est journalisé pour que la sortie dise ce
 * qui a réellement été vérifié.
 */
const streamAbort = new AbortController();
// La fermeture est DÉLIBÉRÉE : un flux SSE ne se termine jamais de lui-même.
// Le rejeu part dès l'ouverture, donc deux secondes suffisent largement.
const closeStream = setTimeout(() => streamAbort.abort(), 2_000);
const stream = await fetch(`${baseUrl}/api/events?cursor=0`, {
  headers: { ...headers, Accept: "text/event-stream" },
  signal: streamAbort.signal,
});
if (!stream.ok) throw new Error(`/api/events failed with HTTP ${stream.status}: ${await stream.text()}`);

const TERMINAL_TYPES = new Set(["run.completed", "run.error"]);
let terminalEvents = 0;
let completions = 0;
let buffer = "";
try {
  const decoder = new TextDecoder();
  for await (const chunk of stream.body as ReadableStream<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // Le heartbeat arrive toutes les 15 s : le voir signifie que la fenêtre
    // rejouée est derrière nous, et qu'il n'y a plus rien à attendre.
    if (buffer.includes(": heartbeat")) break;
  }
} catch (error) {
  // Notre propre `abort` coupe la socket : c'est la fin normale de la lecture.
  // Toute autre panne reste une panne.
  if (!streamAbort.signal.aborted) throw error;
} finally {
  clearTimeout(closeStream);
  streamAbort.abort();
}

for (const frame of buffer.split("\n\n")) {
  const line = frame.split("\n").find((part) => part.startsWith("data:"));
  if (!line) continue;
  const event = JSON.parse(line.slice(5).trim()) as {
    type: string;
    runId: string;
    payload?: Record<string, unknown>;
  };
  const cancelled = event.type === "system.notice" && event.payload?.kind === "cancelled";
  if (!TERMINAL_TYPES.has(event.type) && !cancelled) continue;
  terminalEvents += 1;
  const completion = event.payload?.completion as
    | { version?: number; messages?: unknown; run?: { id?: string } }
    | undefined;
  if (!completion) throw new Error(`Terminal event ${event.type} (${event.runId}) carries no completion block.`);
  if (completion.version !== 1) throw new Error(`Unexpected completion version ${String(completion.version)}.`);
  if (!Array.isArray(completion.messages)) throw new Error("Completion block carries no messages array.");
  if (completion.run?.id !== event.runId) throw new Error("Completion block patches another run.");
  completions += 1;
}

console.info(JSON.stringify({
  event: "e2e.api_cloud_passed",
  organizationId: loginBody.organizationId,
  endpoints: 7,
  terminalEvents,
  completions,
}));
