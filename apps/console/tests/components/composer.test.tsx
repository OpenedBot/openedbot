import { beforeEach, afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { AttachmentCanvas, AttachmentCanvasProvider } from "../../src/components/attachment-canvas";
import { Composer } from "../../src/components/composer";

// Ces cas vérifient une copie FRANÇAISE : la langue est posée explicitement,
// le défaut du produit étant désormais l'anglais (`DEFAULT_LOCALE`).
beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(cleanup);

function renderComposer(value: string, running: boolean, onSubmit = () => {}, onCancel = () => {}) {
  return render(
    <I18nProvider>
      <Composer
        value={value}
        onChange={() => {}}
        onSubmit={onSubmit}
        onCancel={onCancel}
        botName="Hermes"
        disabled={false}
        running={running}
      />
    </I18nProvider>,
  );
}

// La languette de statut n'est pas une étiquette libre au-dessus du composer :
// elle est rendue DANS sa colonne, juste avant la coque, pour faire corps
// avec la carte. Détachée, elle flottait au milieu de la page.
test("la languette de statut est rendue juste au-dessus de la coque", () => {
  const { container } = render(
    <I18nProvider>
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        statusTab={<span data-test-status="">contexte</span>}
      />
    </I18nProvider>,
  );
  const slot = container.querySelector("[data-composer-status]");
  const row = container.querySelector<HTMLElement>("[data-composer-row]");
  expect(slot?.querySelector("[data-test-status]")).not.toBeNull();
  // Template BoardUI : l'état du contexte se range dans la rangée d'actions.
  expect(slot?.parentElement).toBe(row);
});

// Sans languette, aucun conteneur vide ne s'intercale : le composer garde sa
// hauteur exacte, dont dépend le calage clavier iOS.
test("sans languette, aucun conteneur ne s’intercale", () => {
  const { container } = renderComposer("", false);
  expect(container.querySelector("[data-composer-status]")).toBeNull();
});

// La barre est posée DERRIÈRE la carte et dépasse par le haut : la carte
// garde ses quatre coins, sinon ses extrémités hautes deviennent des angles
// droits là où la barre, plus étroite, ne la couvre pas.
test("la barre ne prive pas la coque de ses coins hauts", () => {
  const { container } = render(
    <I18nProvider>
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        statusTab={<span data-test-status="">contexte</span>}
      />
    </I18nProvider>,
  );
  const shell = container.querySelector("[data-composer-shell]");
  expect(shell?.className.split(/\s+/)).toContain("rounded-[var(--radius-2-5xl)]");
  expect(shell?.className).not.toContain("rounded-b-[");
});

test("sans barre, la coque garde ses quatre coins", () => {
  const { container } = renderComposer("", false);
  expect(container.querySelector("[data-composer-shell]")?.className.split(/\s+/)).toContain("rounded-[var(--radius-2-5xl)]");
});

// La cible de réponse s'applique toujours au prochain envoi : un avis du
// runtime (coupure, puis « rétabli » quand l'envoi revient) ne doit pas la
// cacher, sans quoi on répondrait à un message qu'on ne voit plus.
test("un avis du runtime laisse la réponse en cours visible et annulable", () => {
  let cancelled = 0;
  const { container } = render(
    <I18nProvider>
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        notice={<span data-test-notice="">Runtime hors ligne</span>}
        replyPreview={{ author: "Ada", text: "Le message cité" }}
        onCancelReply={() => cancelled++}
      />
    </I18nProvider>,
  );
  const notice = container.querySelector("[data-composer-notice]");
  const reply = container.querySelector("[data-composer-reply]");
  if (!notice || !reply) throw new Error("avis ou onglet de réponse absent");
  expect(notice.querySelector("[data-test-notice]")).not.toBeNull();
  expect(reply.textContent).toContain("Réponse à Ada");
  // L'onglet de réponse vient après l'avis, au plus près de la carte.
  expect(notice.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Annuler la réponse" }));
  expect(cancelled).toBe(1);
});

test("on desktop, Escape stops the run in progress when the field is empty", () => {
  let cancelled = 0;
  renderComposer("", true, () => {}, () => { cancelled += 1; });
  fireEvent.keyDown(document.querySelector("textarea[data-composer]")!, { key: "Escape" });
  expect(cancelled).toBe(1);
});

// With a draft, Send replaces Stop: Escape inside a draft is not an order to stop.
test("Escape inside a draft does not stop the run and keeps the draft", () => {
  let cancelled = 0;
  renderComposer("Une suite", true, () => {}, () => { cancelled += 1; });
  const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  fireEvent.keyDown(field, { key: "Escape" });
  expect(cancelled).toBe(0);
  expect(field.value).toBe("Une suite");
});

// A salon's stop ends the whole room: no shortcut for it.
test("a salon composer does not stop the room on Escape", () => {
  let cancelled = 0;
  render(
    <I18nProvider>
      <Composer value="" onChange={() => {}} onSubmit={() => {}} onCancel={() => { cancelled += 1; }} escapeStopsRun={false} botName="Salon" disabled={false} running />
    </I18nProvider>,
  );
  fireEvent.keyDown(document.querySelector("textarea[data-composer]")!, { key: "Escape" });
  expect(cancelled).toBe(0);
  expect(screen.getByRole("button", { name: "Arrêter la génération" }).hasAttribute("aria-keyshortcuts")).toBe(false);
});

test("Escape stops nothing when no run is in progress", () => {
  let cancelled = 0;
  renderComposer("", false, () => {}, () => { cancelled += 1; });
  fireEvent.keyDown(document.querySelector("textarea[data-composer]")!, { key: "Escape" });
  expect(cancelled).toBe(0);
});

test("the stop button announces its Escape shortcut on desktop", () => {
  renderComposer("", true);
  const stop = screen.getByRole("button", { name: "Arrêter la génération" });
  expect(stop.getAttribute("aria-keyshortcuts")).toBe("Escape");
  expect(stop.getAttribute("title")).toBe("Arrêter la génération (Échap)");
});

// Plus de bande lumineuse autour de la carte pendant un run (retirée à la
// demande) : « Réfléchit… » dans le fil et le bouton Stop suffisent.
test("no band of light runs around the card while a run works", () => {
  renderComposer("", true);
  expect(document.querySelector("[data-composer-shell] svg[data-composer-loader]")).toBeNull();
  expect(screen.getByRole("button", { name: "Arrêter la génération" })).toBeTruthy();
});

test("un run actif garde Stop seul quand le brouillon est vide", () => {
  renderComposer("", true);

  expect(screen.getByRole("button", { name: "Arrêter la génération" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Envoyer" })).toBeNull();
  expect(document.querySelector("[data-composer-stop-action]")).not.toBeNull();
});

test("un brouillon pendant un run remplace Stop par Envoyer", () => {
  let submitted = 0;
  let cancelled = 0;
  const onSubmit = () => { submitted += 1; };
  const onCancel = () => { cancelled += 1; };
  const { container } = renderComposer("Message suivant", true, onSubmit, onCancel);

  const send = screen.getByRole("button", { name: "Envoyer" });
  expect(send.getAttribute("data-composer-action")).toBe("send");
  expect(screen.queryByRole("button", { name: "Arrêter la génération" })).toBeNull();
  expect(container.querySelectorAll("[data-composer-primary-action]").length).toBe(1);

  fireEvent.click(send);
  expect(submitted).toBe(1);
  expect(cancelled).toBe(0);
});

test("un envoi en vol grise Envoyer sans le masquer", () => {
  let submitted = 0;
  render(
    <I18nProvider>
      <Composer
        value="Encore"
        onChange={() => {}}
        onSubmit={() => { submitted += 1; }}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        sending
      />
    </I18nProvider>,
  );

  const send = screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(submitted).toBe(0);
});

test("un composer bloqué explique la raison au survol bureau", async () => {
  const reason = "La connexion avec le runtime est interrompue.";
  const { container } = render(
    <I18nProvider>
      <Composer
        value="Message conservé"
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled
        disabledReason={reason}
        running={false}
      />
    </I18nProvider>,
  );

  const surface = container.querySelector("[data-composer-disabled-surface]");
  expect(surface).not.toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.pointerMove(surface!);
  expect((await screen.findByRole("tooltip")).textContent).toContain(reason);
});

test("un composer bloqué ouvre un dialog au clic sur mobile", async () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  try {
    const reason = "La connexion avec le runtime est interrompue.";
    render(
      <I18nProvider>
        <Composer
          value="Message conservé"
          onChange={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          botName="Hermes"
          disabled
          disabledReason={reason}
          running={false}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: reason }));
    const dialog = await screen.findByRole("alertdialog", { name: "Conversation indisponible" });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain(reason);
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

test("une image importée devient une miniature ouvrable avant l'envoi", () => {
  const attachment = {
    name: "capture.png",
    contentType: "image/png",
    kind: "image" as const,
    content: [{ type: "image" as const, image: "data:image/png;base64,aGVsbG8=" }],
  };
  const { container } = render(
    <I18nProvider>
      <AttachmentCanvasProvider>
        <div className="flex">
          <Composer
            value=""
            onChange={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            botName="Hermes"
            disabled={false}
            running={false}
            attachments={[attachment]}
            onAttachmentsChange={() => {}}
          />
          <AttachmentCanvas />
        </div>
      </AttachmentCanvasProvider>
    </I18nProvider>,
  );

  expect(container.querySelector("[data-composer-image-attachment]")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Agrandir capture.png" }));
  expect(screen.getByRole("complementary", { name: "Lecture de capture.png" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "capture.png" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Fermer le fichier" })).toBeTruthy();
});

function renderWithPlugins(value: string, mcpPlugins: readonly string[]) {
  return render(
    <I18nProvider>
      <Composer
        value={value}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        mcpPlugins={mcpPlugins}
      />
    </I18nProvider>,
  );
}

test("le nom d'un plugin MCP connecté se colore dans le champ", () => {
  const { container } = renderWithPlugins("Regarde dans notion la page", ["notion"]);

  const marks = container.querySelectorAll("[data-composer-mcp-plugin]");
  expect(marks.length).toBe(1);
  expect(marks[0]?.textContent).toBe("notion");
  expect(marks[0]?.getAttribute("data-composer-mcp-plugin")).toBe("notion");
  expect(marks[0]?.getAttribute("data-composer-mcp-match")).toBe("exact");
});

test("un nom approché se colore aussi, à un degré distinct", () => {
  const { container } = renderWithPlugins("va sur notino stp", ["notion"]);

  const mark = container.querySelector("[data-composer-mcp-plugin]");
  expect(mark?.textContent).toBe("notino");
  expect(mark?.getAttribute("data-composer-mcp-match")).toBe("approximate");
});

test("chaque lettre du plugin porte sa propre teinte", () => {
  const { container } = renderWithPlugins("ouvre notion", ["notion"]);

  const letters = container.querySelectorAll("[data-composer-mcp-plugin] .ohb-mcp-letter");
  expect(letters.length).toBe(6);
  expect([...letters].map((letter) => letter.textContent).join("")).toBe("notion");
  const hues = [...letters].map((letter) =>
    (letter as HTMLElement).style.getPropertyValue("--ohb-mcp-hue"),
  );
  expect(hues[0]).toBe("0deg");
  expect(hues[5]).toBe("300deg");
  expect(new Set(hues).size).toBe(6);
});

test("le champ n'efface son texte que lorsqu'un plugin est à l'écran", () => {
  const { container: withPlugin } = renderWithPlugins("ouvre notion", ["notion"]);
  expect(
    withPlugin.querySelector("[data-composer]")?.getAttribute("data-composer-text"),
  ).toBe("mirrored");

  const { container: without } = renderWithPlugins("ouvre le compte rendu", ["notion"]);
  expect(
    without.querySelector("[data-composer]")?.getAttribute("data-composer-text"),
  ).toBeNull();
});

test("une pré-édition IME rend son texte au champ", () => {
  const { container } = renderWithPlugins("ouvre notion", ["notion"]);
  const field = container.querySelector("[data-composer]")!;

  fireEvent.compositionStart(field);
  expect(container.querySelector("[data-composer-mcp-highlight]")).toBeNull();
  expect(field.getAttribute("data-composer-text")).toBeNull();

  fireEvent.compositionEnd(field);
  expect(container.querySelector("[data-composer-mcp-highlight]")).not.toBeNull();
  expect(field.getAttribute("data-composer-text")).toBe("mirrored");
});

test("le calque miroir rend le texte à l'identique, et reste hors de l'arbre a11y", () => {
  const text = "Regarde dans notion, puis GitHub.";
  const { container } = renderWithPlugins(text, ["notion", "github"]);

  const layer = container.querySelector("[data-composer-mcp-highlight]");
  expect(layer?.textContent).toBe(text);
  expect(layer?.getAttribute("aria-hidden")).toBe("true");
});

test("sans plugin connecté, aucun calque n'est monté", () => {
  const { container } = renderWithPlugins("Regarde dans notion", []);

  expect(container.querySelector("[data-composer-mcp-highlight]")).toBeNull();
});

test("un mot qui ne désigne aucun plugin ne monte pas de calque", () => {
  const { container } = renderWithPlugins("Rédige un compte rendu", ["notion"]);

  expect(container.querySelector("[data-composer-mcp-highlight]")).toBeNull();
});

test("le champ garde sa place dans la rangée : un conteneur marqué, enfant direct de la rangée", () => {
  // La barre du bas mobile pose l'ordre, la largeur au focus et les marges du
  // champ par attribut (`mobile.css`). Emballer le textarea sans reporter ce
  // marquage sur l'emballage le sortait du contexte flex : le trombone passait
  // après le champ, et le layout assistant-ui au focus ne se formait plus.
  const { container } = renderComposer("Bonjour", false);

  const field = container.querySelector<HTMLElement>("[data-composer-field]");
  const row = container.querySelector<HTMLElement>("[data-composer-row]");
  expect(field).not.toBeNull();
  expect(field!.parentElement).toBe(row);
  expect(field!.querySelector("textarea[data-composer]")).not.toBeNull();
});

// Pilule (bureau) : une rangée tant que le texte tient sur une ligne, une
// carte dès qu'il passe à la ligne, refermée seulement au champ vide.
test("une nouvelle ligne ouvre la carte, le champ vidé la referme", () => {
  const { container, rerender } = renderComposer("Bonjour", false);
  const row = () => container.querySelector<HTMLElement>("[data-composer-row]")!;
  const field = () => container.querySelector<HTMLElement>("[data-composer-field]")!;
  expect(row().hasAttribute("data-composer-expanded")).toBe(false);
  expect(field().className).not.toContain("sm:basis-full");

  const rerenderWith = (value: string) =>
    rerender(
      <I18nProvider>
        <Composer value={value} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} botName="Hermes" disabled={false} running={false} />
      </I18nProvider>,
    );

  rerenderWith("Bonjour\nla suite");
  expect(row().hasAttribute("data-composer-expanded")).toBe(true);
  expect(field().className).toContain("sm:basis-full");
  // Toujours enfant direct de la rangée : `mobile.css` le place par attribut.
  expect(field().parentElement).toBe(row());

  rerenderWith("");
  expect(row().hasAttribute("data-composer-expanded")).toBe(false);
});

// « Planifier d'abord » est une intention du fil : le menu « + » la pose ou la
// retire, une ligne sous la carte la rappelle et sa croix la retire. Aucune
// pastille de permission ne vit plus dans le composer.
test("Planifier d'abord se pose depuis le menu +, se voit et se retire", async () => {
  const changes: boolean[] = [];
  const view = (planFirst: boolean) => (
    <I18nProvider>
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        onAttachmentsChange={() => {}}
        planFirst={planFirst}
        onPlanFirstChange={(next) => changes.push(next)}
      />
    </I18nProvider>
  );
  const { container, rerender } = render(view(false));
  expect(container.querySelector("[data-composer-permission]")).toBeNull();
  expect(container.querySelector("[data-composer-plan-first]")).toBeNull();
  fireEvent.click(container.querySelector<HTMLButtonElement>("[data-composer-attachment]")!);
  const row = await screen.findByRole("button", { name: /Planifier d’abord/ });
  expect(row.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(row);
  expect(changes).toEqual([true]);

  rerender(view(true));
  expect(container.querySelector("[data-composer-plan-first]")?.textContent).toContain("Hermes propose un plan sans rien modifier");
  fireEvent.click(screen.getByRole("button", { name: "Ne plus planifier d’abord" }));
  expect(changes).toEqual([true, false]);
});

test("sans onPlanFirstChange, le menu + ne propose pas de planifier", async () => {
  const { container } = render(
    <I18nProvider>
      <Composer value="" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} botName="Hermes"
        disabled={false} running={false} onAttachmentsChange={() => {}} />
    </I18nProvider>,
  );
  fireEvent.click(container.querySelector<HTMLButtonElement>("[data-composer-attachment]")!);
  await screen.findByRole("button", { name: /Fichiers et dossiers/ });
  expect(screen.queryByRole("button", { name: /Planifier d’abord/ })).toBeNull();
});
