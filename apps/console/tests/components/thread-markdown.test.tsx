import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { isIntroLine, promoteSummaryCallout, splitLeadLabel, ThreadMarkdown, withGrokMarkdown } from "../../src/components/thread-markdown";

// Ces cas vérifient une copie FRANÇAISE : la langue est posée explicitement,
// le défaut du produit étant désormais l'anglais (`DEFAULT_LOCALE`).
beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(cleanup);

/**
 * Tout bloc de code porte un entête et un bouton Copier, donc des libellés
 * traduits, y compris une arborescence promue depuis de la prose. Le provider
 * n'est pas optionnel.
 */
function renderMarkdown(node: ReactNode) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

describe("ThreadMarkdown", () => {
  test("keeps ASCII tree branches on their own lines", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`/root
├── .hermes
│   ├── attachments
└── videos`}</ThreadMarkdown>,
    );

    const pre = container.querySelector("p pre, pre");
    expect(pre?.textContent).toBe(`/root
├── .hermes
│   ├── attachments
└── videos`);
  });

  test("unflattens branch separators emitted on one line", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`/root └── .hermes ├── attachments/ ├── images/`}</ThreadMarkdown>,
    );

    expect(container.querySelector("pre")?.textContent).toBe(`/root
└── .hermes
├── attachments/
├── images/`);
  });

  /**
   * Relevé sur une vraie réponse du runtime : le modèle sépare un titre de son
   * corps par un simple retour à la ligne, et le markdown strict les recollait
   * en « Extractibilité des réponses Les réponses peuvent… ». Dans un fil, un
   * retour à la ligne est une intention.
   */
  test("un simple retour à la ligne coupe la ligne", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`2. Extractibilité des réponses
Les réponses peuvent être extraites.`}</ThreadMarkdown>,
    );

    expect(container.querySelectorAll("br").length).toBe(1);
    expect(container.textContent).toContain("Extractibilité des réponses");
    expect(container.textContent).not.toContain("réponses Les réponses");
  });

  test("un paragraphe reste un paragraphe", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`Premier paragraphe.

Second paragraphe.`}</ThreadMarkdown>,
    );

    expect(container.querySelectorAll("p").length).toBe(2);
    expect(container.querySelectorAll("br").length).toBe(0);
  });
});

describe("ThreadMarkdown: arborescence sans fence", () => {
  test("des chemins consécutifs deviennent un bloc monospace", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`Structure proposée :

src/
Shared/
Domain/
Application/
Infrastructure/

Chaque module métier contient :`}</ThreadMarkdown>,
    );

    const listing = container.querySelector("[data-path-listing]");
    expect(listing?.textContent).toBe("src/\nShared/\nDomain/\nApplication/\nInfrastructure/");
    expect(container.querySelectorAll("p").length).toBe(2);
  });

  test("le listing prend la carte des blocs de code et son bouton Copier", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`src/
Shared/
Domain/`}</ThreadMarkdown>,
    );

    const block = container.querySelector("[data-code-block]");
    expect(block?.getAttribute("data-code-block")).toBe("");
    expect(block?.querySelector("button")?.getAttribute("aria-label")).toBe("Copier");
    // Sans langage, aucun surlignage : une arborescence n'a pas de syntaxe.
    expect(block?.querySelector("[data-path-listing]")?.textContent).toBe("src/\nShared/\nDomain/");
    expect(block?.querySelector(".shiki")).toBeNull();
  });

  test("des chemins avec ellipse restent groupés", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`src/Order/Domain/...
src/Order/Application/Command/...
tests/Unit/...`}</ThreadMarkdown>,
    );
    expect(container.querySelector("[data-path-listing]")).not.toBeNull();
  });

  test("une phrase avec une barre reste de la prose", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`Le ratio est de 3/4 environ.
On continue.`}</ThreadMarkdown>,
    );
    expect(container.querySelector("[data-path-listing]")).toBeNull();
    expect(container.querySelector("p")).not.toBeNull();
  });
});

describe("ThreadMarkdown: bloc de code", () => {
  test("un bloc fencé : la carte de Grok Bot, Copier flottant, le langage pour les lecteurs d'écran", () => {
    const { container } = render(
      <I18nProvider>
        <ThreadMarkdown streaming>{"```php\n$a = 1;\n```"}</ThreadMarkdown>
      </I18nProvider>,
    );
    const block = container.querySelector("[data-code-block]");
    expect(block?.getAttribute("data-code-block")).toBe("php");
    const caption = block?.querySelector("figcaption");
    expect(caption?.textContent).toBe("php");
    expect(caption?.className).toContain("sr-only");
    const copy = block?.querySelector<HTMLElement>("[data-code-copy]");
    expect(copy?.getAttribute("aria-label")).toBe("Copier");
    expect(copy?.className).toContain("absolute");
    expect(copy?.textContent).toBe("");
    expect(block?.querySelector("pre code")?.textContent).toBe("$a = 1;");
  });
});

describe("withGrokMarkdown", () => {
  const base = { name: "github-light", type: "light" as const, tokenColors: [{ scope: "markup.heading", settings: { foreground: "#005cc5", fontStyle: "bold" } }] };

  test("ajoute les couleurs markdown de Grok APRÈS celles du thème, qui gardent le reste", () => {
    const theme = withGrokMarkdown(base, "light");
    expect(theme.name).toBe("github-light-grok-markdown");
    expect(theme.tokenColors?.[0]).toEqual(base.tokenColors[0]);
    const heading = theme.tokenColors?.find((rule) => rule.scope === "markup.heading.markdown entity.name.section.markdown");
    expect(heading?.settings).toEqual({ foreground: "#b3003f", fontStyle: "bold" });
    const url = theme.tokenColors?.find((rule) => rule.scope === "markup.underline.link.markdown");
    expect(url?.settings).toEqual({ foreground: "#206595", fontStyle: "" });
  });

  test("le sombre a sa palette : titres turquoise, liens roses", () => {
    const heading = withGrokMarkdown(base, "dark").tokenColors?.find((rule) => rule.scope === "markup.heading.markdown entity.name.section.markdown");
    expect(heading?.settings.foreground).toBe("#82d2ce");
  });
});

describe("promoteSummaryCallout", () => {
  test("le « En résumé » final devient un encart", () => {
    const out = promoteSummaryCallout("Corps.\n\nEn résumé : monolithe modulaire, domaines isolés.");
    expect(out).toBe("Corps.\n\n> [!NOTE] En résumé\n> monolithe modulaire, domaines isolés.");
  });

  test("un résumé au milieu n'est pas touché", () => {
    const text = "En résumé : rien.\n\nSuite du cours.";
    expect(promoteSummaryCallout(text)).toBe(text);
  });

  test("une fence ouverte protège le texte", () => {
    const text = "```\nEn résumé : code";
    expect(promoteSummaryCallout(text)).toBe(text);
  });

  test("rendu : l'encart porte le titre et le corps", () => {
    const { container } = render(
      <I18nProvider>
        <ThreadMarkdown>{"Corps.\n\nEn résumé : tout va bien."}</ThreadMarkdown>
      </I18nProvider>,
    );
    const aside = container.querySelector("aside");
    expect(aside?.textContent).toContain("En résumé");
    expect(aside?.textContent).toContain("tout va bien.");
  });
});

describe("ThreadMarkdown: gras implicite", () => {
  test("une ligne d'annonce terminée par deux-points devient un intertitre", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`Principes techniques :

- DTO stricts ;
- validation Symfony.`}</ThreadMarkdown>,
    );
    const intro = container.querySelector<HTMLElement>("[data-intro-line]");
    expect(intro?.textContent).toBe("Principes techniques :");
    expect(intro?.className).toContain("font-semibold");
    expect(container.querySelectorAll("[data-intro-line]").length).toBe(1);
  });

  test("le label d'une définition porte le gras, pas la suite", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`Domain : entités, value objects, règles métier. Aucune dépendance à Symfony.`}</ThreadMarkdown>,
    );
    const p = container.querySelector("p");
    expect(p?.querySelector("strong")?.textContent).toBe("Domain");
    expect(p?.textContent).toBe("Domain : entités, value objects, règles métier. Aucune dépendance à Symfony.");
  });

  test("un label de plusieurs mots est accepté, une phrase ne l'est pas", () => {
    expect(splitLeadLabel("API Platform : pour une API orientée ressources.")?.[0]).toBe("API Platform");
    expect(splitLeadLabel("Contrôleurs Symfony classiques : avec DTO.")?.[0]).toBe("Contrôleurs Symfony classiques");
    expect(splitLeadLabel("Dans les deux cas, je séparerais les modèles : lecture et écriture.")).toBeNull();
    expect(splitLeadLabel("POST /orders/{id}/confirm : action métier.")).toBeNull();
    expect(splitLeadLabel("http://exemple.fr : lien")).toBeNull();
    expect(splitLeadLabel("Mais : non")).toBeNull();
  });

  test("une phrase qui finit par deux-points mais contient un point reste un paragraphe", () => {
    expect(isIntroLine("Pour la couche API, je ferais ce choix :")).toBe(true);
    expect(isIntroLine("Je pars sur Symfony 7.4. Ensuite :")).toBe(false);
    expect(isIntroLine("x".repeat(100) + " :")).toBe(false);
  });

  test("un premier enfant déjà balisé n'est pas retouché", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`**Domain** : déjà en gras.`}</ThreadMarkdown>,
    );
    expect(container.querySelectorAll("strong").length).toBe(1);
    expect(container.querySelector("[data-lead-label]")).toBeNull();
  });

  test("un lien d'une réponse part dans un autre onglet, sans référent", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`Lien : https://x.com/elonmusk/status/2094983639780204846`}</ThreadMarkdown>,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://x.com/elonmusk/status/2094983639780204846");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noreferrer");
  });

  test("un lien markdown explicite suit la même règle, une ancre interne reste dans la page", () => {
    const { container } = renderMarkdown(
      <ThreadMarkdown>{`[le post](https://x.com/elonmusk) et [plus bas](#suite)`}</ThreadMarkdown>,
    );
    const [externe, ancre] = [...container.querySelectorAll("a")];
    expect(externe?.getAttribute("target")).toBe("_blank");
    expect(ancre?.getAttribute("href")).toBe("#suite");
    expect(ancre?.getAttribute("target")).toBeNull();
  });
});
