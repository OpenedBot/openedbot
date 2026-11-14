import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster, toast } from "@openedbot/browser-ui-kit";
import type { BotDto, BotRoutineToolDto, RoutineDto, RoutineExecutionDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { BotRoutinesPanel } from "../../src/components/bot-routines-dialog";
import { ROUTINE_TOOL_REFETCH_MS, routineToolRefetchMs } from "../../src/components/routine-tool-card";
import { RoutineExecutionsList } from "../../src/components/routine-executions-list";
import { browserTimeZone } from "../../src/lib/routines/schedule";

const realFetch = globalThis.fetch;
const viewerZone = browserTimeZone();
// Any zone the test machine is not in.
const otherZone = viewerZone === "Pacific/Chatham" ? "Pacific/Kiritimati" : "Pacific/Chatham";

beforeEach(() => window.localStorage.setItem("openedbot:locale", "fr"));
afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

function routine(patch: Partial<RoutineDto> = {}): RoutineDto {
  return {
    id: "r-1", botId: "bot-1", groupId: null, name: "Revue", schedule: "30 17 * * *", timezone: viewerZone,
    message: "Résume ma boîte", enabled: true, nextRunAt: "2026-11-12T16:30:00.000Z", lastRunAt: null,
    missedCount: 0, lastMissedAt: null, waitingForHost: false,
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", neverWait: false,
    ...patch,
  };
}

type Call = { method: string; url: string; body: unknown };
type Handler = (call: Call) => Response | undefined;

function mockApi(routines: RoutineDto[], calls: Call[], handler: Handler = () => undefined, executions: RoutineExecutionDto[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const handled = handler(call);
    if (handled) return handled;
    if (url.includes("/routine-tool")) return Response.json({ enabled: true, available: false, status: "unavailable", reason: "runtime_required", restartPending: false });
    if (url.includes("/executions")) return Response.json({ executions, nextCursor: null });
    if (url.includes("/routines") && call.method === "GET") return Response.json({ routines });
    return Response.json({});
  }) as typeof fetch;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <BotRoutinesPanel bot={{ id: "bot-1", name: "Atlas", threadId: "thread-1" } as BotDto} open />
        <Toaster />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function card(id = "r-1"): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-routine="${id}"]`)!;
}

describe("routine list", () => {
  test("shows a preset with its time, the quota from the domain, and no zone when it is the reader's", async () => {
    mockApi([routine()], []);
    renderPanel();
    await screen.findByText("Tous les jours à 17:30");
    expect(screen.getByText("1 / 20")).toBeTruthy();
    expect(within(card()).queryByText(/fuseau/)).toBeNull();
  });

  test("names the routine's zone, and the reader's on the next run, when they differ", async () => {
    mockApi([routine({ timezone: otherZone })], []);
    renderPanel();
    await screen.findByText(`Tous les jours à 17:30 (fuseau ${otherZone})`);
    const next = within(card()).getByText(/^Prochaine exécution/).textContent!;
    // `timeZoneName: "short"` appends the reader's zone to the instant.
    expect(next).toMatch(/(UTC|GMT|[A-Z]{3,4})/);
  });

  test("a cron that fits no preset is shown as is", async () => {
    mockApi([routine({ schedule: "*/15 8-18 * * 1-5" })], []);
    renderPanel();
    await screen.findByText("*/15 8-18 * * 1-5");
  });

  test("a one-shot run manually then paused keeps its switch, not « Déclenché »", async () => {
    mockApi([routine({ schedule: "at 2099-12-01T08:00:00Z", enabled: false, nextRunAt: null, lastRunAt: "2026-11-12T08:00:00.000Z" })], []);
    renderPanel();
    await screen.findByRole("switch", { name: "Activer « Revue »" });
    expect(screen.queryByText("Déclenché")).toBeNull();
  });

  test("a one-shot sent by the tick shows « Déclenché »", async () => {
    mockApi([routine({ schedule: "at 2026-11-01T08:00:00Z", enabled: false, nextRunAt: null, lastRunAt: "2026-11-01T08:00:02.000Z" })], []);
    renderPanel();
    await screen.findByText("Déclenché");
  });

  test("a paused one-shot whose time passed unsent offers the switch and says it goes out at once", async () => {
    const calls: Call[] = [];
    const overdue = routine({ schedule: "at 2026-11-01T08:00:00Z", enabled: false, nextRunAt: null });
    mockApi([overdue], calls, ({ method }) =>
      method === "PATCH" ? Response.json({ ...overdue, enabled: true, nextRunAt: new Date().toISOString() }) : undefined);
    renderPanel();
    const toggle = await screen.findByRole("switch", { name: "Activer « Revue »" });
    expect(screen.getByText(/la réactiver l’envoie aussitôt/)).toBeTruthy();
    fireEvent.click(toggle);
    await screen.findAllByText("« Revue » est réactivée et part maintenant.");
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ enabled: true });
  });
});

describe("host offline", () => {
  test("waitingForHost: the row says so and « Exécuter maintenant » is disabled with the reason", async () => {
    mockApi([routine({ waitingForHost: true, nextRunAt: "2026-11-12T08:00:00.000Z" })], []);
    renderPanel();
    await screen.findByText("En attente de l’hôte");
    const run = screen.getByRole("button", { name: "Exécuter « Revue » maintenant" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    const hint = document.getElementById(run.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toContain("dès le retour de l’hôte");
    expect(within(card()).queryByText(/^Prochaine exécution/)).toBeNull();
  });

  test("a 409 ROUTINE_HOST_OFFLINE on run-now shows the product's message and rereads the list", async () => {
    const calls: Call[] = [];
    mockApi([routine()], calls, ({ method, url }) => method === "POST" && url.endsWith("/runs")
      ? Response.json({ error: { code: "ROUTINE_HOST_OFFLINE", message: "texte serveur" } }, { status: 409 })
      : undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Exécuter « Revue » maintenant" }));
    await screen.findAllByText("L’hôte est hors ligne : relancez la routine une fois qu’il est reconnecté.");
    const lists = () => calls.filter((call) => call.method === "GET" && call.url.endsWith("/bots/bot-1/routines")).length;
    await waitFor(() => expect(lists()).toBeGreaterThanOrEqual(2));
  });
});

describe("edit", () => {
  test("opens on the existing preset and time, and submits only the changed name", async () => {
    const calls: Call[] = [];
    mockApi([routine()], calls, ({ method }) => method === "PATCH" ? Response.json(routine({ name: "Revue du soir" })) : undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Modifier « Revue »" }));
    const time = within(card()).getByLabelText("Heure") as HTMLInputElement;
    expect(time.value).toBe("17:30");
    const save = screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText("Renommer ou changer le message garde la prochaine exécution prévue.")).toBeTruthy();
    expect(within(card()).getByText(`Les horaires sont en ${viewerZone}.`)).toBeTruthy();
    fireEvent.change(within(card()).getByLabelText("Nom"), { target: { value: "Revue du soir" } });
    fireEvent.click(save);
    await screen.findAllByText("« Revue du soir » est enregistrée.");
    expect(calls.filter((call) => call.method === "PATCH").map((call) => [call.url, call.body])).toEqual([
      [expect.stringContaining("/api/routines/r-1"), { name: "Revue du soir" }],
    ]);
  });

  test("a new time sends the schedule only and says the next run is recomputed", async () => {
    const calls: Call[] = [];
    mockApi([routine()], calls, ({ method }) => method === "PATCH" ? Response.json(routine({ schedule: "0 18 * * *" })) : undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Modifier « Revue »" }));
    fireEvent.change(within(card()).getByLabelText("Heure"), { target: { value: "18:00" } });
    expect(screen.getByText("Tous les jours à 18:00")).toBeTruthy();
    expect(screen.getByText(/recalcule la prochaine exécution/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ schedule: "0 18 * * *" }));
  });

  test("a cron that fits no preset opens in custom mode, unaltered", async () => {
    mockApi([routine({ schedule: "0 9 * * 7" })], []);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Modifier « Revue »" }));
    expect((within(card()).getByLabelText("Expression cron") as HTMLInputElement).value).toBe("0 9 * * 7");
    expect((screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a routine in another zone always shows it, and offers the reader's", async () => {
    const calls: Call[] = [];
    mockApi([routine({ timezone: otherZone })], calls, ({ method }) => method === "PATCH" ? Response.json(routine()) : undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Modifier « Revue »" }));
    expect(within(card()).getByText(`Les horaires sont en ${otherZone}.`, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Utiliser mon fuseau (${viewerZone})` }));
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ timezone: viewerZone }));
  });

  test("a one-shot keeps its date: only name and message are editable", async () => {
    mockApi([routine({ schedule: "at 2099-12-01T08:00:00Z" })], []);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Modifier « Revue »" }));
    expect(screen.getByText(/Un rappel ponctuel garde sa date/)).toBeTruthy();
    expect(within(card()).queryByLabelText("Heure")).toBeNull();
    expect(within(card()).queryByLabelText("Expression cron")).toBeNull();
  });
});

describe("delete", () => {
  test("asks for confirmation before deleting, and cancel deletes nothing", async () => {
    const calls: Call[] = [];
    mockApi([routine()], calls, ({ method }) => method === "DELETE" ? new Response(null, { status: 204 }) : undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Supprimer la routine" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Supprimer « Revue » ?")).toBeTruthy();
    expect(within(dialog).getByText(/historique d’exécutions/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Supprimer la routine" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url))
      .toEqual([expect.stringContaining("/api/routines/r-1")]));
  });
});

let next = 0;
function execution(patch: Partial<RoutineExecutionDto> = {}): RoutineExecutionDto {
  next += 1;
  return {
    id: `e-${next}`, routineId: "r-1", outcome: "fired", trigger: "scheduled", missedCount: 0, busyRetries: null,
    errorCode: null, errorMessage: null, workflowId: "w", runId: "run", threadId: "t", workflowStatus: null,
    createdAt: "2026-11-12T10:00:00.000Z", ...patch,
  };
}

function renderHistory(executions: RoutineExecutionDto[], schedule = "0 9 * * *") {
  mockApi([], [], undefined, executions);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <RoutineExecutionsList routine={{ id: "r-1", name: "Revue", schedule }} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("history", () => {
  test("shows the run's real outcome apart from the firing; a failed run is never green", async () => {
    const statuses = ["running", "completed", "failed", "cancelled", "awaiting_approval"] as const;
    renderHistory(statuses.map((workflowStatus) => execution({ workflowStatus })));
    await screen.findAllByText("Lancée");
    const labels = statuses.map((status) => document.querySelector(`[data-run-status="${status}"]`)?.textContent);
    expect(labels).toEqual(["RésultatEn cours", "RésultatTerminé", "RésultatÉchoué", "RésultatAnnulé", "RésultatDécision requise"]);
    const failed = document.querySelector('[data-run-status="failed"] [data-slot="badge"]') ?? document.querySelector('[data-run-status="failed"] span');
    expect(failed?.className).toContain("neg-soft");
    expect(failed?.className).not.toContain("pos");
    const fired = screen.getAllByText("Lancée")[0]!;
    expect(fired.className).not.toContain("pos");
    expect(document.querySelector('[data-run-status="completed"] span')?.className).toContain("pos-soft");
  });

  test("collapses one occurrence's deferrals into one line with a count", async () => {
    renderHistory([
      execution({ outcome: "fired", workflowStatus: "completed" }),
      ...[5, 4, 3, 2, 1].map((busyRetries) => execution({ outcome: "deferred", busyRetries, workflowId: null, runId: null })),
    ]);
    await screen.findByText("Reportée 5 fois");
    expect(document.querySelectorAll("[data-execution]")).toHaveLength(2);
    expect(screen.getByText(/^Premier report :/)).toBeTruthy();
    expect(screen.getByText("Fil occupé : nouvel essai dans 60 s.")).toBeTruthy();
  });

  test("maps known error codes to messages and keeps the API's text for unknown ones", async () => {
    renderHistory([
      execution({ outcome: "abandoned", errorCode: "ROUTINE_FIRE_FAILED", errorMessage: "brut" }),
      execution({ outcome: "abandoned", errorCode: "ROUTINE_BUSY_RETRIES_EXHAUSTED", errorMessage: "brut" }),
      execution({ outcome: "abandoned", errorCode: "NEW_CODE", errorMessage: "Message de l’API" }),
    ], "at 2026-11-12T08:00:00Z");
    await screen.findByText("Le tir a échoué 10 fois de suite : occurrence abandonnée.");
    expect(screen.getByText(/rappel abandonné, replanifiez-le/)).toBeTruthy();
    expect(screen.getByText("Message de l’API")).toBeTruthy();
    expect(screen.queryByText(/ROUTINE_FIRE_FAILED/)).toBeNull();
  });
});

describe("« Programmer depuis le chat » (0187)", () => {
  const tool = (patch: Partial<BotRoutineToolDto>): BotRoutineToolDto => ({
    enabled: true, available: true, status: "active", reason: null, restartPending: false, ...patch,
  });
  const withTool = (state: BotRoutineToolDto, calls: Call[] = [], onPut?: (body: unknown) => BotRoutineToolDto) => {
    let current = state;
    mockApi([], calls, ({ url, method, body }) => {
      if (!url.includes("/routine-tool")) return undefined;
      if (method === "PUT" && onPut) current = onPut(body);
      return Response.json(current);
    });
  };
  const statusText = async () => (await waitFor(() => {
    const node = document.querySelector("[data-routine-tool-status]");
    if (!node) throw new Error("no status yet");
    return node;
  })).textContent;

  test("on by default and active: the switch is on and the empty list invites asking the bot", async () => {
    withTool(tool({}));
    renderPanel();
    expect(await statusText()).toBe("Actif : Atlas programme ce que vous lui demandez dans la conversation.");
    const toggle = await screen.findByRole("switch", { name: "Autoriser Atlas à gérer ses routines" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await screen.findByText(/Demandez à Atlas dans la conversation/);
  });

  test.each([
    [{ status: "pending", reason: null }, "En cours d’installation sur votre serveur"],
    [{ status: "pending", reason: "host_offline" }, "Votre serveur est hors ligne : l’outil s’installera dès son retour"],
    // Already installed: nothing is left to install, the bot waits for its host.
    [{ status: "active", reason: "host_offline" }, "Installé. Votre serveur est hors ligne : Atlas programmera dès son retour."],
    [{ status: "pending", reason: "host_unreachable" }, "Votre serveur n’a pas pu joindre openedbot"],
    [{ status: "pending", reason: "unverified" }, "Votre serveur n’a pas confirmé l’installation"],
    [{ status: "pending", reason: "profile_preparing" }, "Le profil de Atlas se prépare sur votre serveur"],
    [{ status: "unavailable", reason: "profile_failed", available: false }, "relancez sa création"],
    [{ status: "unavailable", reason: "https_required", available: false }, "API openedbot publique en https"],
    [{ status: "unavailable", reason: "runtime_required", available: false }, "Reliez un runtime Hermes"],
    [{ status: "unavailable", reason: "host_unsupported", available: false }, "mettez `edge-setup` à jour"],
    [{ status: "unavailable", reason: "profile_unsupported", available: false }, "capacités par profil"],
  ] as const)("not active (%o): the reason in the product's words, the switch still on, no invitation to ask", async (patch, text) => {
    withTool(tool(patch as Partial<BotRoutineToolDto>));
    renderPanel();
    expect(await statusText()).toContain(text);
    const toggle = await screen.findByRole("switch", { name: "Autoriser Atlas à gérer ses routines" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    await screen.findByText("Aucune routine pour l’instant.");
  });

  test("restart pending: says so and offers the gateway restart, which only the operator triggers", async () => {
    withTool(tool({ status: "restart_pending", restartPending: true }));
    renderPanel();
    expect(await statusText()).toContain("redémarrez le gateway pour que Atlas puisse s’en servir");
    expect(await statusText()).toContain("Rien ne redémarre sans vous.");
  });

  test("the card reads the state again only while the API is moving it", () => {
    expect(routineToolRefetchMs(tool({ status: "pending" }))).toBe(ROUTINE_TOOL_REFETCH_MS);
    expect(routineToolRefetchMs(tool({ status: "restart_pending" }))).toBe(ROUTINE_TOOL_REFETCH_MS);
    for (const status of ["active", "switched_off", "unavailable"] as const) expect(routineToolRefetchMs(tool({ status }))).toBe(false);
    expect(routineToolRefetchMs(undefined)).toBe(false);
  });

  test("a failed switch still reads the state again: the choice may be recorded", async () => {
    const calls: Call[] = [];
    mockApi([], calls, ({ url, method }) => url.includes("/routine-tool")
      ? (method === "PUT" ? Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }) : Response.json(tool({})))
      : undefined);
    renderPanel();
    fireEvent.click(await screen.findByRole("switch", { name: "Autoriser Atlas à gérer ses routines" }));
    await waitFor(() => expect(calls.filter((call) => call.url.includes("/routine-tool") && call.method === "GET").length).toBeGreaterThanOrEqual(2));
  });

  test("switching off is the remembered opt-out; the card says so", async () => {
    const calls: Call[] = [];
    withTool(tool({}), calls, () => tool({ enabled: false, status: "switched_off" }));
    renderPanel();
    fireEvent.click(await screen.findByRole("switch", { name: "Autoriser Atlas à gérer ses routines" }));
    await screen.findAllByText("Atlas ne programme plus depuis le chat. Ce choix est conservé.");
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ enabled: false });
    expect(await statusText()).toContain("Désactivé pour Atlas");
    const toggle = screen.getByRole("switch", { name: "Autoriser Atlas à gérer ses routines" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
