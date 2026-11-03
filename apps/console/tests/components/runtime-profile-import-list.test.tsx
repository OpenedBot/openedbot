import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RuntimeHostProfileDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { RuntimeProfileImportList } from "../../src/components/runtime-profile-import-list";

beforeEach(() => window.localStorage.setItem("ohb:locale", "fr"));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const scout: RuntimeHostProfileDto = {
  name: "scout",
  displayName: "Scout",
  title: "Scout",
  description: "Trouver des sources.",
  model: { default: "claude-sonnet-4", provider: "anthropic" },
  hasAvatar: false,
  routineCount: 2,
  routines: [
    { name: "Morning brief", schedule: "30 8 * * 1-5", prompt: "Go", enabled: true, deliver: true, model: null },
    { name: "Evening brief", schedule: "0 18 * * *", prompt: "Summarize", enabled: false, deliver: false, model: null },
  ],
  pinned: true,
  mcpServers: [],
  alreadyImported: false,
  importedBotId: null,
};

const editor: RuntimeHostProfileDto = {
  ...scout,
  name: "editor",
  displayName: "Editor",
  description: null,
  routineCount: 0,
  routines: [],
  alreadyImported: true,
  importedBotId: "bot-1",
};

test("liste titre, mission, modèle, routines, et désactive un profil déjà importé", () => {
  const seen: string[] = [];
  render(
    <I18nProvider>
      <RuntimeProfileImportList
        profiles={[scout, editor]}
        selected={new Set(["scout"])}
        onToggle={(slug) => seen.push(slug)}
      />
    </I18nProvider>,
  );
  expect(screen.getByText("Scout")).toBeTruthy();
  expect(screen.getByText("Trouver des sources.")).toBeTruthy();
  expect(screen.getAllByText(/claude-sonnet-4/).length).toBe(2);
  expect(screen.getByText(/2 routine/)).toBeTruthy();
  expect(screen.getByText("Détails des routines")).toBeTruthy();
  fireEvent.click(screen.getByText("Détails des routines"));
  expect(screen.getByText("Morning brief")).toBeTruthy();
  expect(screen.getByText(/30 8 \* \* 1-5/)).toBeTruthy();
  expect(screen.getByText("Editor")).toBeTruthy();
  expect(screen.getByText(/Déjà importé/)).toBeTruthy();
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes[1]).toHaveProperty("disabled", true);
  fireEvent.click(boxes[0]!);
  expect(seen).toEqual(["scout"]);
});
