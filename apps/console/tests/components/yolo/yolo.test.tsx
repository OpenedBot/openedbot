import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotDto, BotPermissionMode, EffectiveYolo, PermissionContextDto, YoloLeaseDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { queryKeys } from "../../../src/lib/api";
import { formatCountdown } from "../../../src/lib/countdown";
import { saveCloudSession } from "../../../src/lib/session/cloud-session";
import { PermissionModeBadge } from "../../../src/components/boardui/permission-picker";
import { YoloGrantDialog } from "../../../src/components/yolo/yolo-grant-dialog";
import { YoloLeasesCard } from "../../../src/components/yolo/yolo-leases-card";
import { YoloBotSection } from "../../../src/components/yolo/yolo-bot-section";
import { YoloAuditSection } from "../../../src/components/yolo/yolo-audit-section";

const realFetch = globalThis.fetch;
const ORG = "00000000-0000-4000-8000-0000000000aa";
const BOT = "00000000-0000-4000-8000-0000000000b1";
const THREAD = "00000000-0000-4000-8000-0000000000c1";
const RUNTIME = "00000000-0000-4000-8000-0000000000d1";
const LEASE = "00000000-0000-4000-8000-0000000000e1";
const V2: PermissionContextDto = { pipeline: "v2", maxMode: null, enforceReview: false, reviewProven: true };

type Role = "owner" | "admin" | "member";
type Call = { method: string; path: string; body: unknown };
type Route = (call: Call) => Response | undefined;

let calls: Call[] = [];

function inHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function lease(overrides: Partial<YoloLeaseDto> = {}): YoloLeaseDto {
  return {
    id: LEASE, scope: "thread", runtimeId: RUNTIME, botId: BOT, threadId: THREAD, grantedByUserId: "user-one",
    issuedAt: new Date().toISOString(), expiresAt: inHours(4), revokedAt: null, hostState: "active", deliveredAt: null,
    ...overrides,
  };
}

function bot(permissionMode: BotPermissionMode, yolo: EffectiveYolo | null = null): BotDto {
  return {
    id: BOT, threadId: THREAD, name: "Recherche", slug: "recherche", description: null, instructions: "",
    model: null, reasoningEffort: null, sectionId: "section-1", position: 0, pinned: false, face: null, voiceId: null,
    hermesProfile: "recherche", isolation: "profile", hasOwnRuntime: false, runtimeName: "Local", awaitingApproval: false,
    preview: null, lastActivityAt: new Date().toISOString(), archivedAt: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastRunAt: null, permissionMode,
    effectivePermission: { mode: permissionMode, reason: null, yolo },
  } as unknown as BotDto;
}

/** Answers each request with the first route that knows it, else an empty 200; every call is recorded. */
function stubFetch(...routes: Route[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const call = { method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    return Response.json({});
  }) as typeof fetch;
}

const leasesRoute = (leases: YoloLeaseDto[]): Route => (call) =>
  call.method === "GET" && call.path.startsWith("/api/organization/yolo/leases") ? Response.json({ leases }) : undefined;

const consentRoute = (acknowledgedAt: string | null): Route => (call) =>
  call.path === "/api/organization/yolo/consent"
    ? Response.json({ acknowledgedAt: call.method === "PUT" ? new Date().toISOString() : acknowledgedAt, soloDefault: false })
    : undefined;

function renderWith(node: React.ReactNode, { role = "owner", context = V2 }: { role?: Role; context?: PermissionContextDto | null } = {}) {
  // `staleTime: Infinity`: the identity and the roster seeded below are not read again from the stub.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } });
  client.setQueryData(queryKeys.authMe, {
    kind: "session",
    user: { id: "user-one", email: "operator@example.com", displayName: "Operator" },
    organization: { id: ORG, slug: "acme", name: "Acme" },
    session: { role, canWrite: true, impersonation: null },
  });
  client.setQueryData(queryKeys.runtimeConfiguration, {
    runtime: null, runtimeMode: "cloud", adminMode: "disabled", devDefaults: null,
    ...(context ? { permissionContext: context } : {}),
  });
  client.setQueryData(queryKeys.roster, { bots: [bot("manual")], sections: [], groups: [], operator: null });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const yoloBadge = () => document.querySelector<HTMLElement>("[data-yolo-badge]");

beforeEach(() => {
  calls = [];
  window.localStorage.setItem("ohb:locale", "fr");
  saveCloudSession({ organizationId: ORG, csrfToken: "csrf-test", userId: "user-one" });
  stubFetch();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("le compte à rebours", () => {
  test("minutes et secondes sous l'heure, heures au-delà, jamais négatif", () => {
    expect(formatCountdown(59 * 60_000)).toBe("59:00");
    expect(formatCountdown(4 * 3_600_000)).toBe("4:00:00");
    expect(formatCountdown(3_600_000 + 61_000)).toBe("1:01:01");
    expect(formatCountdown(-5_000)).toBe("00:00");
  });
});

describe("le badge YOLO", () => {
  test("un bail sur le bot l'emporte sur Accès complet et compte à partir de l'échéance du serveur", async () => {
    let opened = 0;
    renderWith(<PermissionModeBadge bot={bot("bypass", { leaseId: LEASE, scope: "bot", expiresAt: inHours(2) })} onOpen={() => { opened += 1; }} />);
    await waitFor(() => expect(yoloBadge()?.getAttribute("data-yolo-badge")).toBe("bot"));
    expect(document.querySelector("[data-permission-badge]")).toBeNull();
    expect(yoloBadge()!.textContent).toContain("YOLO");
    expect(yoloBadge()!.querySelector("[data-yolo-countdown]")!.textContent).toMatch(/^[12]:[0-5]\d:[0-5]\d$/);
    expect(yoloBadge()!.getAttribute("aria-label")).toContain("YOLO actif pour ce bot");
    expect(yoloBadge()!.getAttribute("title")).toContain("liste hardline");
    fireEvent.click(yoloBadge()!);
    expect(opened).toBe(1);
  });

  test("un bail échu ne s'affiche pas", async () => {
    renderWith(<PermissionModeBadge bot={bot("manual", { leaseId: LEASE, scope: "runtime", expiresAt: inHours(-1) })} onOpen={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(yoloBadge()).toBeNull();
  });

  test("le bail de la conversation affichée se lit, et le Mode plan l'ignore", async () => {
    stubFetch(leasesRoute([lease()]));
    renderWith(<PermissionModeBadge bot={bot("manual")} threadId={THREAD} onOpen={() => {}} />);
    await waitFor(() => expect(yoloBadge()?.getAttribute("data-yolo-badge")).toBe("thread"));
    expect(calls.find((call) => call.path.includes("/yolo/leases"))!.path).toBe(`/api/organization/yolo/leases?threadId=${THREAD}`);
    cleanup();
    renderWith(<PermissionModeBadge bot={bot("plan")} threadId={THREAD} onOpen={() => {}} />);
    await waitFor(() => expect(document.querySelector("[data-permission-badge]")?.getAttribute("data-permission-badge")).toBe("plan"));
    expect(yoloBadge()).toBeNull();
  });
});

describe("l'octroi et la confirmation de la première fois", () => {
  const grantRoute = (response: () => Response): Route => (call) =>
    call.method === "POST" && call.path === "/api/organization/yolo/leases" ? response() : undefined;
  const granted = () => Response.json({ lease: lease() }, { status: 201 });

  function openThreadGrant(onClose = () => {}) {
    renderWith(<YoloGrantDialog open onClose={onClose} scopes={["thread"]} botId={BOT} threadId={THREAD} />);
  }

  test("la première fois, une alerte s'interpose ; confirmer envoie acknowledged puis PUT /consent", async () => {
    let closed = 0;
    stubFetch(consentRoute(null), grantRoute(granted));
    openThreadGrant(() => { closed += 1; });
    expect((screen.getByLabelText("Durée") as HTMLSelectElement).value).toBe("4");
    await waitFor(() => expect(calls.some((call) => call.path === "/api/organization/yolo/consent")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Activer YOLO" }));
    const alert = await screen.findByRole("alertdialog", { name: "Première activation du mode YOLO" });
    expect(alert.textContent).toContain("chemins protégés");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "J’ai compris, activer" }));
    await waitFor(() => expect(closed).toBe(1));
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/organization/yolo/leases",
      "PUT /api/organization/yolo/consent",
    ]);
    expect(writes[0]!.body).toEqual({ scope: "thread", botId: BOT, threadId: THREAD, durationMinutes: 240, acknowledged: true });
    expect(writes[1]!.body).toEqual({ acknowledged: true });
  });

  test("une fois la confirmation donnée, on ne la redemande pas", async () => {
    stubFetch(consentRoute("2026-11-01T09:00:00.000Z"), grantRoute(granted));
    openThreadGrant();
    fireEvent.change(screen.getByLabelText("Durée"), { target: { value: "24" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Activer YOLO" }) as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/organization/yolo/consent")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Activer YOLO" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({ scope: "thread", botId: BOT, threadId: THREAD, durationMinutes: 1440 });
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  test("un refus 409 dit sa raison au lieu de rabattre en silence", async () => {
    for (const [code, reason, text] of [
      ["YOLO_BLOCKED_BY_POLICY", "ceiling", "Votre organisation plafonne le mode de permission sous Accès complet : le mode YOLO est refusé."],
      ["YOLO_BLOCKED_BY_POLICY", "enforce_review", "Votre organisation impose la revue : le mode YOLO est refusé."],
      ["YOLO_HOST_UNSUPPORTED", "yolo_thread_scope", "Le connecteur de ce runtime ne sait pas limiter YOLO à une conversation : choisissez le bot ou le runtime."],
      ["YOLO_HOST_UNSUPPORTED", "yolo_lease", "Le connecteur de ce runtime ne sait pas encore appliquer un bail YOLO : mettez-le à jour."],
    ] as const) {
      calls = [];
      stubFetch(consentRoute("2026-11-01T09:00:00.000Z"), grantRoute(() =>
        Response.json({ error: { code, message: "Refus du serveur.", details: { reason } } }, { status: 409 })));
      openThreadGrant();
      await waitFor(() => expect(calls.some((call) => call.path === "/api/organization/yolo/consent")).toBe(true));
      await waitFor(() => expect((screen.getByRole("button", { name: "Activer YOLO" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "Activer YOLO" }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      cleanup();
    }
  });

  test("un 428 du serveur ouvre la confirmation, même si l'écran la croyait donnée", async () => {
    stubFetch(consentRoute("2026-11-01T09:00:00.000Z"), grantRoute(() =>
      Response.json({ error: { code: "YOLO_ACK_REQUIRED", message: "Confirmez." } }, { status: 428 })));
    openThreadGrant();
    await waitFor(() => expect(calls.some((call) => call.path === "/api/organization/yolo/consent")).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: "Activer YOLO" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Activer YOLO" }));
    expect(await screen.findByRole("alertdialog", { name: "Première activation du mode YOLO" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Couper YOLO partout", () => {
  test("une confirmation, puis POST /kill ; Annuler ne poste rien", async () => {
    stubFetch(leasesRoute([lease({ scope: "bot", threadId: null })]), (call) =>
      call.method === "POST" && call.path === "/api/organization/yolo/kill" ? Response.json({ revoked: 1, runtimes: 1 }) : undefined);
    renderWith(<YoloLeasesCard />);
    const row = await waitFor(() => {
      const element = document.querySelector(`[data-yolo-lease="${LEASE}"]`);
      if (!element) throw new Error("lease row missing");
      return element;
    });
    expect(row.textContent).toContain("Recherche");
    expect(row.textContent).toMatch(/encore [34]:[0-5]\d:[0-5]\d/);
    expect(row.textContent).toContain("Appliqué par l’hôte");

    fireEvent.click(screen.getByRole("button", { name: "Couper YOLO partout" }));
    expect(await screen.findByRole("alertdialog", { name: "Couper YOLO partout ?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((call) => call.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Couper YOLO partout" }));
    fireEvent.click(await screen.findByRole("button", { name: "Couper partout" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/organization/yolo/kill"]);
  });

  test("révoquer un bail le vise seul", async () => {
    stubFetch(leasesRoute([lease({ scope: "runtime", botId: null, threadId: null })]));
    renderWith(<YoloLeasesCard runtimeId={RUNTIME} />);
    fireEvent.click(await screen.findByRole("button", { name: "Couper le bail YOLO : Tout le runtime" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    expect(calls.find((call) => call.method === "DELETE")!.path).toBe(`/api/organization/yolo/leases/${LEASE}`);
    expect(calls.find((call) => call.path.startsWith("/api/organization/yolo/leases?"))!.path).toBe(`/api/organization/yolo/leases?runtimeId=${RUNTIME}`);
  });

  test("un membre lit les baux, sans aucun bouton pour agir", async () => {
    stubFetch(leasesRoute([lease({ scope: "bot", threadId: null })]));
    renderWith(<YoloLeasesCard />, { role: "member" });
    await waitFor(() => expect(document.querySelector(`[data-yolo-lease="${LEASE}"]`)).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Couper YOLO partout" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Couper le bail/ })).toBeNull();
    expect(screen.getByText("Seuls le propriétaire et les administrateurs activent ou coupent le mode YOLO.")).toBeTruthy();
  });
});

describe("la rubrique YOLO de la fiche du bot", () => {
  test("le plafond de l'organisation est dit, et l'octroi désactivé", async () => {
    renderWith(<YoloBotSection bot={bot("bypass")} />, { context: { ...V2, maxMode: "auto" } });
    expect(await screen.findByText("Votre organisation plafonne le mode de permission sous Accès complet : le mode YOLO est refusé.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Activer YOLO…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("un bail qui court sans s'appliquer est nommé : ici le Mode plan", async () => {
    stubFetch(leasesRoute([lease({ scope: "bot", threadId: null })]));
    renderWith(<YoloBotSection bot={bot("plan")} />);
    expect(await screen.findByText("Un bail YOLO court, mais ce bot est en Mode plan : ses écritures restent bloquées.")).toBeTruthy();
  });

  test("un bail actif montre son compte à rebours et se coupe", async () => {
    renderWith(<YoloBotSection bot={bot("manual", { leaseId: LEASE, scope: "runtime", expiresAt: inHours(3) })} />);
    await waitFor(() => expect(yoloBadge()?.getAttribute("data-yolo-badge")).toBe("runtime"));
    expect(document.querySelector("[data-yolo-bot]")!.textContent).toMatch(/YOLO actif pour tout le runtime : encore [23]:[0-5]\d:[0-5]\d\./);
    fireEvent.click(screen.getByRole("button", { name: "Couper" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.path === `/api/organization/yolo/leases/${LEASE}`)).toBe(true));
  });

  test("un membre voit l'état, jamais le bouton d'octroi", async () => {
    renderWith(<YoloBotSection bot={bot("manual", { leaseId: LEASE, scope: "bot", expiresAt: inHours(1) })} />, { role: "member" });
    await waitFor(() => expect(yoloBadge()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Activer YOLO…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Couper" })).toBeNull();
    expect(screen.getByText("Seuls le propriétaire et les administrateurs activent ou coupent le mode YOLO.")).toBeTruthy();
  });
});

describe("le journal des auto-approbations", () => {
  test("owner : outil, porte, hash des arguments, date et bail", async () => {
    stubFetch((call) => call.path.startsWith("/api/organization/yolo/audit")
      ? Response.json({
          entries: [{
            id: "1", runtimeId: RUNTIME, leaseId: LEASE, writeSeq: 1, occurredAt: "2026-11-01T09:00:00.000Z",
            profile: "recherche", gateKind: "terminal", toolKey: "terminal.exec", argsHash: "a".repeat(64), entryHash: "b".repeat(64),
          }],
          nextCursor: null,
        })
      : undefined);
    renderWith(<YoloAuditSection />);
    expect(await screen.findByText("Auto-approuvés (YOLO)")).toBeTruthy();
    const entry = await waitFor(() => {
      const element = document.querySelector("[data-yolo-audit-entry='1']");
      if (!element) throw new Error("entry missing");
      return element;
    });
    expect(entry.textContent).toContain("terminal.exec");
    expect(entry.textContent).toContain("terminal");
    expect(entry.textContent).toContain("aaaaaaaaaaaa…");
    expect(entry.querySelector(`[title="${"a".repeat(64)}"]`)).not.toBeNull();
    expect(entry.querySelector(`[title="${LEASE}"]`)).not.toBeNull();
  });

  test("un membre ne voit pas la section et rien n'est lu", async () => {
    renderWith(<YoloAuditSection />, { role: "member" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector("[data-yolo-audit]")).toBeNull();
    expect(calls.some((call) => call.path.includes("/yolo/audit"))).toBe(false);
  });
});
