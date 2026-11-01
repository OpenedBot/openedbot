import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotDto, BotPermissionMode, PermissionContextDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { queryKeys } from "../../../src/lib/api";
import { PermissionModeBadge, PermissionModeList } from "../../../src/components/boardui/permission-picker";

let selected: BotPermissionMode[] = [];

beforeEach(() => {
  selected = [];
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function bot(permissionMode: BotPermissionMode): BotDto {
  return {
    id: "bot-1", threadId: "thread-1", name: "Hermes", slug: "hermes", description: null, instructions: "",
    model: null, reasoningEffort: null, sectionId: "section-1", position: 0, pinned: false, face: null, voiceId: null,
    hermesProfile: null, isolation: "profile", hasOwnRuntime: false, runtimeName: "Local", awaitingApproval: false,
    preview: null, lastActivityAt: new Date().toISOString(), archivedAt: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastRunAt: null, permissionMode,
  } as unknown as BotDto;
}

const V2: PermissionContextDto = { pipeline: "v2", maxMode: null, enforceReview: false, reviewProven: true };

function withProviders(node: React.ReactNode, context: PermissionContextDto | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.runtimeConfiguration, {
    runtime: null, runtimeMode: "cloud", adminMode: "disabled", devDefaults: null,
    ...(context ? { permissionContext: context } : {}),
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const radio = (name: RegExp) => screen.getByRole("radio", { name });

async function open(mode: BotPermissionMode, context: PermissionContextDto | null) {
  withProviders(
    <PermissionModeList value={mode} context={context} autoFocus onSelect={(next) => selected.push(next)} ariaLabel="Mode de permission" />,
    context,
  );
  await screen.findByRole("radiogroup", { name: "Mode de permission" });
}

describe("la liste des modes", () => {
  test("quatre lignes, dans l'ordre, avec une phrase vraie par mode", async () => {
    await open("manual", V2);
    const rows = screen.getAllByRole("radio");
    expect(rows.map((row) => row.getAttribute("data-permission-mode"))).toEqual(["manual", "auto", "plan", "bypass"]);
    // The first text node is the mode's name; « Expérimental » follows Revue auto under v2.
    expect(rows.map((row) => row.querySelector("span span")?.firstChild?.textContent)).toEqual(["Demander", "Revue auto", "Mode plan", "Accès complet"]);
    expect(radio(/^Demander/).textContent).toContain("Chaque écriture ou commande à risque vous est demandée");
    expect(radio(/^Revue auto/).textContent).toContain("Un relecteur IA répond");
    expect(radio(/^Mode plan/).textContent).toContain("les écritures sont bloquées");
    expect(radio(/^Accès complet/).textContent).toContain("le plancher");
    expect(radio(/^Demander/).getAttribute("aria-checked")).toBe("true");
  });

  test("sous le moteur historique, Revue auto ne promet pas de relecteur", async () => {
    await open("manual", { pipeline: "legacy", maxMode: null, enforceReview: false, reviewProven: false });
    expect(radio(/^Revue auto/).textContent).not.toContain("relecteur");
    expect(radio(/^Revue auto/).textContent).toContain("Agit seul");
  });

  test("choisir un mode le rend à l'appelant", async () => {
    await open("manual", V2);
    fireEvent.click(radio(/^Mode plan/));
    expect(selected).toEqual(["plan"]);
  });
});

describe("le plafond de l'organisation", () => {
  test("une option au-dessus du plafond reste visible, désactivée, et n'écrit rien", async () => {
    await open("manual", { ...V2, maxMode: "auto" });
    const full = radio(/^Accès complet/);
    expect(full.getAttribute("aria-disabled")).toBe("true");
    expect(full.textContent).toContain("Limité par votre organisation");
    expect(radio(/^Revue auto/).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(full);
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(selected).toEqual([]);
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "4" });
    expect(selected).toEqual([]);
  });

  test("le mode plan reste permis sous n'importe quel plafond, et un bot déjà au-dessus peut rester", async () => {
    await open("bypass", { ...V2, maxMode: "manual" });
    expect(radio(/^Mode plan/).getAttribute("aria-disabled")).toBeNull();
    expect(radio(/^Demander/).getAttribute("aria-disabled")).toBeNull();
    expect(radio(/^Accès complet/).getAttribute("aria-disabled")).toBeNull();
    expect(radio(/^Revue auto/).getAttribute("aria-disabled")).toBeNull();
  });
});

describe("le clavier", () => {
  test("le focus arrive sur le mode actif, les flèches se déplacent en sautant les options désactivées", async () => {
    await open("manual", { ...V2, maxMode: "manual" });
    // manual, plan allowed; auto and bypass above the ceiling.
    await waitFor(() => expect(document.activeElement).toBe(radio(/^Demander/)));
    const group = screen.getByRole("radiogroup");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(document.activeElement).toBe(radio(/^Mode plan/));
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(document.activeElement).toBe(radio(/^Demander/));
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(document.activeElement).toBe(radio(/^Mode plan/));
  });

  test("un seul arrêt de tabulation dans la liste", async () => {
    await open("auto", V2);
    const stops = screen.getAllByRole("radio").filter((row) => row.getAttribute("tabindex") === "0");
    expect(stops).toEqual([radio(/^Revue auto/)]);
  });

  test("les touches 1 à 4 choisissent le mode de la ligne", async () => {
    await open("manual", V2);
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "4" });
    expect(selected).toEqual(["bypass"]);
  });
});

describe("l'indicateur d'en-tête", () => {
  function renderBadge(mode: BotPermissionMode, context: PermissionContextDto | null, onOpen = () => {}) {
    withProviders(<PermissionModeBadge bot={bot(mode)} onOpen={onOpen} />, context);
  }
  const badge = () => document.querySelector<HTMLButtonElement>("[data-permission-badge]");

  test("rien pour Demander et Revue auto : ce sont les modes de tous les jours", () => {
    renderBadge("manual", V2);
    expect(badge()).toBeNull();
    cleanup();
    renderBadge("auto", V2);
    expect(badge()).toBeNull();
  });

  test("Mode plan et Accès complet se voient, et le clic ouvre la fiche", async () => {
    let opened = 0;
    renderBadge("plan", V2, () => { opened += 1; });
    await waitFor(() => expect(badge()?.textContent).toBe("Mode plan"));
    expect(badge()!.getAttribute("title")).toContain("toutes les conversations et routines");
    fireEvent.click(badge()!);
    expect(opened).toBe(1);
    cleanup();
    renderBadge("bypass", V2);
    await waitFor(() => expect(badge()?.getAttribute("data-permission-badge")).toBe("bypass"));
    expect(badge()!.querySelector("[data-permission-effective]")).toBeNull();
  });

  test("le plafond rabat Accès complet et la raison est annoncée", async () => {
    renderBadge("bypass", { ...V2, maxMode: "manual" });
    await waitFor(() => expect(badge()?.querySelector("[data-permission-effective]")?.textContent).toBe("→ Demander"));
    expect(badge()!.getAttribute("title")).toContain("Votre organisation plafonne");
    expect(badge()!.getAttribute("aria-label")).toContain("agit comme Demander");
  });

  test("la revue imposée fait agir Accès complet comme Revue auto", async () => {
    renderBadge("bypass", { ...V2, enforceReview: true });
    await waitFor(() => expect(badge()?.querySelector("[data-permission-effective]")?.textContent).toBe("→ Revue auto"));
    expect(badge()!.getAttribute("title")).toContain("impose la revue");
  });
});
