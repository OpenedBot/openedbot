/**
 * E2E against an API that is already running.
 * Run from the repository root: bun tests/e2e/link-connector.ts
 * Required environment: E2E_EMAIL and E2E_PASSWORD for an explicitly selected
 * test account; optional E2E_API_URL (default http://127.0.0.1:8790).
 * The account must use external mode. Credentials are never logged.
 * The original active connector is restored and the created runtime revoked
 * in finally. Pending tickets have no cancellation API and expire after 5 min.
 *
 * Le script joue le client de bout en bout, sans rien mocker côté API :
 *   1. démarre un faux gateway Hermes en processus (port éphémère) ;
 *   2. ouvre un enrôlement `connector` depuis une session opérateur ;
 *   3. lance le fake host agent (tests/fake-hermes/host-agent.ts) avec le
 *      ticket : dial, hello, sonde à travers le tuyau, `link.issued` ;
 *   4. vérifie que le runtime publié est `connector`, lié, sans URL ;
 *   5. reconnecte avec le jeton de lien et rejoue `POST /api/runtime/test`.
 *
 * Le bearer du gateway ne quitte jamais ce processus ; le jeton de lien
 * n'apparaît dans aucune réponse HTTP.
 */

import { startFakeHermes } from "../fake-hermes/server";
import { FakeHostAgent } from "../fake-hermes/host-agent";
import { passwordLogin } from "../../scripts/lib/password-login";

const baseUrl = (process.env.E2E_API_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
if (!email || !password) throw new Error("Set E2E_EMAIL and E2E_PASSWORD explicitly for the test account.");
// En mode `separate`, la WebSocket du lien est servie par la passerelle
// (RUNTIME_LINK_HOST:RUNTIME_LINK_PORT), pas par l'API.
const linkHost = process.env.RUNTIME_LINK_HOST && process.env.RUNTIME_LINK_HOST !== "0.0.0.0" ? process.env.RUNTIME_LINK_HOST : "127.0.0.1";
const linkOrigin = process.env.RUNTIME_LINK_MODE === "separate"
  ? `http://${linkHost}:${process.env.RUNTIME_LINK_PORT ?? "8791"}`
  : baseUrl;
const wsUrl = `${linkOrigin.replace(/^http/, "ws")}/api/runtime-links/ws`;
const gatewayToken = `link-e2e-${crypto.randomUUID()}`;

const health = await fetch(`${baseUrl}/api/health`);
if (!health.ok) throw new Error(`Cloud health failed with HTTP ${health.status}.`);

const login = await passwordLogin(baseUrl, { email, password });
if (!login.ok) throw new Error(`Cloud login failed with HTTP ${login.status}: ${await login.text()}`);
const loginBody = await login.json() as { csrfToken: string; organizationId: string };
const setCookie = login.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(",").map((part) => part.trim().split(";")[0]).filter(Boolean).join("; ");
if (!cookie || !loginBody.csrfToken || !loginBody.organizationId) {
  throw new Error("Cloud login did not return session cookies and organization.");
}
const headers = {
  Cookie: cookie,
  "X-CSRF-Token": loginBody.csrfToken,
  "X-OpenedBot-Organization": loginBody.organizationId,
  "Content-Type": "application/json",
};

type RuntimeSnapshot = {
  runtimeMode: string;
  runtimes: Array<{ id: string; isActive: boolean; reachability: string; link: { connected: boolean } | null }>;
};
async function readRuntimes(): Promise<RuntimeSnapshot> {
  const response = await fetch(`${baseUrl}/api/runtime/list`, { headers });
  if (!response.ok) throw new Error(`runtime snapshot failed with HTTP ${response.status}.`);
  return response.json() as Promise<RuntimeSnapshot>;
}
const original = await readRuntimes();
const originalActive = original.runtimes.find((runtime) => runtime.isActive);
// Enrollment sets external mode, and nothing can restore a direct runtime
// once replaced. Reject these accounts before creating anything.
if (original.runtimeMode !== "external"
  || (originalActive && (originalActive.reachability !== "connector" || !originalActive.link?.connected))) {
  throw new Error("This test requires external mode and either no active runtime or an active connected connector.");
}
const originalIds = new Set(original.runtimes.map((runtime) => runtime.id));
const agents: FakeHostAgent[] = [];
let enrollmentId: string | null = null;
let createdRuntimeId: string | null = null;
let testSucceeded = false;
let testError: unknown;

const gateway = startFakeHermes({ port: 0, token: gatewayToken });
const gatewayUrl = `http://127.0.0.1:${gateway.port}`;

try {
  const opened = await fetch(`${baseUrl}/api/runtime-enrollments/open`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Link e2e ${new Date().toISOString()}`, reachability: "connector" }),
  });
  if (opened.status !== 201) throw new Error(`open failed with HTTP ${opened.status}: ${await opened.text()}`);
  const enrollment = await opened.json() as { enrollmentId: string; ticket: string; command?: string };
  enrollmentId = enrollment.enrollmentId;
  if (!enrollment.command?.startsWith("edge-setup link ")) {
    throw new Error("open did not return the edge-setup link command.");
  }
  if (enrollment.command.includes(enrollment.ticket)) {
    throw new Error("the enrollment ticket leaked into the command argv.");
  }

  const agent = new FakeHostAgent({
    wsUrl,
    auth: { kind: "enrollment", ticket: enrollment.ticket },
    gatewayUrl,
    gatewayToken,
  });
  agents.push(agent);
  await agent.connect();
  const issued = await agent.waitLinkIssued();
  createdRuntimeId = issued.runtimeId;
  if (originalIds.has(createdRuntimeId)) throw new Error("Enrollment unexpectedly reused an existing runtime.");
  console.info(JSON.stringify({ event: "link_e2e.link_issued", runtimeId: issued.runtimeId }));

  const status = await fetch(`${baseUrl}/api/runtime-enrollments/${enrollment.enrollmentId}/status`, { headers });
  if (!status.ok) throw new Error(`status failed with HTTP ${status.status}: ${await status.text()}`);
  const statusBody = await status.json() as { state: string; runtimeId: string | null };
  if (statusBody.state !== "completed" || statusBody.runtimeId !== issued.runtimeId) {
    throw new Error(`enrollment status is ${JSON.stringify(statusBody)}, expected completed + runtime id.`);
  }
  if (JSON.stringify(statusBody).includes(issued.linkToken)) {
    throw new Error("the link token leaked into an HTTP response.");
  }

  const list = await fetch(`${baseUrl}/api/runtime/list`, { headers });
  if (!list.ok) throw new Error(`runtime list failed with HTTP ${list.status}.`);
  const listBody = await list.json() as { runtimes: Array<{ id: string; reachability: string; baseUrl: string | null; link: { connected: boolean } | null }> };
  const runtime = listBody.runtimes.find((entry) => entry.id === issued.runtimeId);
  if (!runtime) throw new Error("the enrolled runtime is not listed.");
  if (runtime.reachability !== "connector" || runtime.baseUrl !== null || runtime.link?.connected !== true) {
    throw new Error(`unexpected published runtime shape: ${JSON.stringify(runtime)}`);
  }
  if (JSON.stringify(listBody).includes(issued.linkToken)) {
    throw new Error("the link token leaked into the runtime list.");
  }

  // Recovery changes the provider form without replacing this socket.
  agent.announceCapabilities(["provider_management"]);
  let recovered = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const refreshed = await fetch(`${baseUrl}/api/runtime/list`, { headers });
    if (!refreshed.ok) throw new Error(`capability refresh failed with HTTP ${refreshed.status}.`);
    const body = await refreshed.json() as { runtimes: Array<{
      id: string;
      linkFeatures: string[];
      link: { connected: boolean; lastReplacedAt: string | null } | null;
      management: { kind: string; credentialsWritable: boolean };
    }> };
    const current = body.runtimes.find((entry) => entry.id === issued.runtimeId);
    if (current?.linkFeatures.includes("provider_management")) {
      if (current.management.kind !== "host" || !current.management.credentialsWritable
        || !current.link?.connected || current.link.lastReplacedAt !== null || agent.closeCode !== null) {
        throw new Error("capability recovery replaced the socket or did not enable host credentials.");
      }
      recovered = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!recovered) throw new Error("capabilities were not persisted on the original link.");
  console.info(JSON.stringify({ event: "link_e2e.capabilities_recovered_in_place", runtimeId: issued.runtimeId }));

  // This event is explicitly synthetic and belongs only to the test runtime.
  // The stack marker exercises redaction and storage; it is not a real crash.
  const diagnostic = {
    t: "diagnostic" as const,
    eventId: crypto.randomUUID(), component: "operator" as const, state: "unavailable" as const,
    code: "E2E_TEST", occurredAt: new Date().toISOString(),
    message: "Synthetic E2E diagnostic persistence check",
    stack: "SYNTHETIC_E2E_STACK\napi_key=synthetic-redaction-marker\nlink-connector.ts:1",
  };
  await agent.sendDiagnostic(diagnostic);
  await agent.sendDiagnostic(diagnostic);
  const diagnosticResponse = await fetch(`${baseUrl}/api/runtime/${issued.runtimeId}/diagnostics?limit=10`, { headers });
  if (!diagnosticResponse.ok) throw new Error(`diagnostic read failed with HTTP ${diagnosticResponse.status}.`);
  const diagnosticBody = await diagnosticResponse.json() as { diagnostics: Array<{
    eventId: string; code: string; message: string; stack: string | null;
  }> };
  const captured = diagnosticBody.diagnostics.filter((entry) => entry.eventId === diagnostic.eventId);
  if (captured.length !== 1 || captured[0]?.code !== "E2E_TEST"
    || captured[0]?.message !== diagnostic.message
    || captured[0]?.stack !== "SYNTHETIC_E2E_STACK\napi_key=[redacted]\nlink-connector.ts:1") {
    throw new Error("Diagnostic capture, stack redaction or duplicate suppression failed through the live API.");
  }
  console.info(JSON.stringify({ event: "link_e2e.diagnostic_captured", runtimeId: issued.runtimeId, eventId: diagnostic.eventId, synthetic: true, duplicateSuppressed: true }));

  // Le runtime enrôlé n'est pas forcément l'actif, et la bascule
  // (`/activate`) est retirée (410) : on sonde CE runtime par son id, la sonde
  // passe par le tuyau du lien.
  const testUrl = `${baseUrl}/api/runtime/${issued.runtimeId}/test`;
  const tested = await fetch(testUrl, { method: "POST", headers });
  if (!tested.ok) throw new Error(`runtime test through the link failed with HTTP ${tested.status}: ${await tested.text()}`);

  // Reconnexion : le jeton de lien remplace le ticket, la session précédente est remplacée (4001).
  const reconnected = new FakeHostAgent({
    wsUrl,
    auth: { kind: "link", runtimeId: issued.runtimeId, linkToken: issued.linkToken },
    gatewayUrl,
    gatewayToken,
  });
  agents.push(reconnected);
  await reconnected.connect();
  await Bun.sleep(300);
  const retested = await fetch(testUrl, { method: "POST", headers });
  if (!retested.ok) throw new Error(`runtime test after reconnection failed with HTTP ${retested.status}: ${await retested.text()}`);

  testSucceeded = true;
} catch (error) {
  testError = error;
} finally {
  const cleanupErrors: string[] = [];
  // Stop every created agent even when connect/enrollment failed. The original
  // connector is never in this array.
  for (const agent of agents) {
    try { agent.close(); }
    catch { cleanupErrors.push("A test agent could not be closed."); }
  }
  try {
    if (enrollmentId) {
      const status = await fetch(`${baseUrl}/api/runtime-enrollments/${enrollmentId}/status`, { headers });
      if (!status.ok) throw new Error(`cleanup enrollment status failed with HTTP ${status.status}.`);
      const enrollment = await status.json() as { state: string; runtimeId: string | null; expiresAt: string };
      // The enrollment may have committed even if link.issued was lost.
      createdRuntimeId ??= enrollment.runtimeId;
      if (!createdRuntimeId && enrollment.state !== "expired") {
        // The existing API has no cancellation endpoint. Do not pretend the
        // ticket was deleted: it expires automatically after five minutes.
        console.warn(JSON.stringify({ event: "link_e2e.enrollment_pending_expiry", enrollmentId, expiresAt: enrollment.expiresAt }));
      }
    }
    if (createdRuntimeId) {
      if (originalIds.has(createdRuntimeId)) throw new Error("Refusing to clean up a pre-existing runtime.");
      const current = await readRuntimes();
      const currentActive = current.runtimes.find((runtime) => runtime.isActive);
      if (currentActive?.id === createdRuntimeId && originalActive) {
        // The switch between runtimes is retired (/activate answers 410): this
        // test never makes its runtime active, so this is someone else's change.
        throw new Error("The test runtime became active; refusing to touch the original runtime.");
      } else if (currentActive && currentActive.id !== createdRuntimeId && currentActive.id !== originalActive?.id) {
        throw new Error("The active runtime changed outside this test; refusing to overwrite that choice.");
      }
      const removed = await fetch(`${baseUrl}/api/runtime/${createdRuntimeId}`, {
        method: "DELETE", headers,
        ...(originalActive ? {} : { body: JSON.stringify({ confirm: true }) }),
      });
      if (!removed.ok && removed.status !== 404) throw new Error(`removing the test runtime failed with HTTP ${removed.status}.`);
    }
    const final = await readRuntimes();
    if (final.runtimeMode !== original.runtimeMode
      || final.runtimes.find((runtime) => runtime.isActive)?.id !== originalActive?.id
      || (createdRuntimeId && final.runtimes.some((runtime) => runtime.id === createdRuntimeId))) {
      throw new Error("Runtime cleanup did not restore the original runtime configuration.");
    }
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : "Unknown cleanup failure");
  } finally {
    gateway.stop(true);
  }
  if (cleanupErrors.length) {
    if (testError) console.error(testError);
    throw new Error(`Link E2E cleanup failed: ${cleanupErrors.join("; ")}`);
  }
}
if (testError) throw testError;
if (testSucceeded) console.info(JSON.stringify({ event: "link_e2e.passed", runtimeId: createdRuntimeId, cleaned: true }));
