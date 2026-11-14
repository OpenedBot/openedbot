import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../../../src/lib/i18n";
import { HermesTokenHelpDialog } from "../../../../src/screens/settings/installation/cloud";

function renderHelp(url: string) {
  render(
    <I18nProvider>
      <HermesTokenHelpDialog url={url} />
    </I18nProvider>,
  );
}

function commands(): string[] {
  return screen.getAllByText((_, element) => element?.tagName === "CODE")
    .map((element) => element.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("aide au token Hermes", () => {
  test("reste fermée tant qu’on ne la demande pas", () => {
    renderHelp("https://hermes.example.com");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Où trouver le token ?" })).toBeTruthy();
  });

  // The host comes from the URL already entered: copying a generic command and then
  // replacing a `<hôte>` by hand is the gesture where one picks the wrong machine.
  test("adresse la commande à l’hôte de l’URL saisie", async () => {
    renderHelp("https://hermes.openedbot.app");
    fireEvent.click(screen.getByRole("button", { name: "Où trouver le token ?" }));

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    const read = commands().find((value) => value.startsWith("ssh ") && value.includes("API_SERVER_KEY"));
    expect(read).toBe(
      `ssh hermes-admin@hermes.openedbot.app 'sudo -n sed -n "s/^API_SERVER_KEY=//p" /srv/hermes/data/runtime.env | head -1'`,
    );
  });

  test("suit le compte SSH choisi", async () => {
    renderHelp("https://hermes.openedbot.app");
    fireEvent.click(screen.getByRole("button", { name: "Où trouver le token ?" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Compte SSH d’administration"), { target: { value: "debian" } });

    await waitFor(() => {
      expect(commands().some((value) => value.includes("ssh debian@hermes.openedbot.app"))).toBe(true);
    });
  });

  test("ne fabrique pas d’hôte quand l’URL est vide ou invalide", async () => {
    renderHelp("pas-une-url");
    fireEvent.click(screen.getByRole("button", { name: "Où trouver le token ?" }));

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(commands().some((value) => value.includes("@<hôte>"))).toBe(true);
  });

  // Creation rewrites a file the gateway rereads at startup. Losing its
  // owner or its mode 0600 breaks the service or exposes the bearer; forgetting
  // the restart makes a rotation that did not take look real.
  test("montre une création atomique, qui préserve les droits et recharge l’unité", async () => {
    renderHelp("https://hermes.openedbot.app");
    fireEvent.click(screen.getByRole("button", { name: "Où trouver le token ?" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    const create = commands().find((value) => value.includes("openssl rand"));
    expect(create).toBeTruthy();
    expect(create).toContain("umask 077");
    expect(create).toContain('grep -v "^API_SERVER_KEY=" "$f"');
    expect(create).toContain('chown --reference="$f" "$t"');
    expect(create).toContain('chmod --reference="$f" "$t"');
    expect(create).toContain('mv -f "$t" "$f"');
    expect(commands().some((value) => value === "sudo systemctl restart hermes-gateway.service")).toBe(true);
  });

  test("avertit que le token traverse le terminal et invalide l’ancien", async () => {
    renderHelp("https://hermes.openedbot.app");
    fireEvent.click(screen.getByRole("button", { name: "Où trouver le token ?" }));

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText(/s’affiche dans votre terminal/)).toBeTruthy();
    expect(screen.getByText(/invalide[\s\S]*immédiatement l’ancien/)).toBeTruthy();
  });
});
