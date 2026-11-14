import { describe, expect, test } from "bun:test";
import {
  isGithubAlert,
  parseGithubAlertMarker,
  splitArticleSections,
  splitAssistantCards,
  toneFromHeading,
} from "../../../src/lib/stream/assistant-article-sections";

describe("toneFromHeading", () => {
  test("classifies FR and EN headings", () => {
    expect(toneFromHeading("12. Erreurs fréquentes")).toBe("warning");
    expect(toneFromHeading("Attention : signes")).toBe("warning");
    expect(toneFromHeading("13. Résumé à retenir")).toBe("method");
    expect(toneFromHeading("Méthode en 4 étapes")).toBe("method");
    expect(toneFromHeading("Exercices")).toBe("exercise");
    expect(toneFromHeading("Practice quiz")).toBe("exercise");
    expect(toneFromHeading("Réponses")).toBe("answer");
    expect(toneFromHeading("Solutions")).toBe("section");
    expect(toneFromHeading("Forme canonique")).toBe("section");
  });

  /**
   * The « answer » tone is the only one that folds its section into a closed
   * `<details>`: misclassifying an ordinary title does not add one border too
   * many, it makes text the model produced, and billed, disappear.
   *
   * Observed on a real answer: « 2. Extractibilité des réponses » was
   * folded, and the screen rendered only 568 of the 1281 persisted characters.
   */
  test("ne replie que le titre QUI EST l'étiquette, pas celui qui la contient", () => {
    expect(toneFromHeading("2. Extractibilité des réponses")).toBe("section");
    expect(toneFromHeading("Qualité des réponses générées")).toBe("section");
    expect(toneFromHeading("Answer coverage by market")).toBe("section");
    expect(toneFromHeading("Corriger le maillage interne")).toBe("section");

    // and the label itself always folds: in its usual forms
    for (const étiquette of ["Réponses", "Réponses :", "3. Réponses", "Answers", "Corrigé", "Corrigés", "Correction"]) {
      expect(toneFromHeading(étiquette)).toBe("answer");
    }
  });
});

describe("parseGithubAlertMarker / isGithubAlert", () => {
  test("reads GitHub alert markers", () => {
    expect(parseGithubAlertMarker("[!WARNING]")).toEqual({ type: "WARNING" });
    expect(parseGithubAlertMarker("[!NOTE] Custom title")).toEqual({
      type: "NOTE",
      title: "Custom title",
    });
    expect(parseGithubAlertMarker("[!tip]")).toEqual({ type: "TIP" });
    expect(parseGithubAlertMarker("just a quote")).toBeNull();
  });

  test("detects a blockquote alert", () => {
    expect(isGithubAlert("> [!WARNING]\n> Oublier que a ≠ 0")).toBe(true);
    expect(isGithubAlert("> une citation")).toBe(false);
  });
});

describe("splitArticleSections", () => {
  const lesson = `# Équation du second degré

On cherche les racines de $ax^2+bx+c=0$.

## 12. Erreurs fréquentes

Oublier que $a \\neq 0$.

## 13. Résumé à retenir

1. Identifier $a,b,c$.
2. Calculer $\\Delta$.

### Si Δ > 0

Deux solutions.

### Si Δ = 0

Une solution.

### Si Δ < 0

Pas de solution réelle.

## Exercices

1. $x^2-7x+12=0$

## Réponses

1. $S=\\{3;4\\}$
`;

  test("splits a lesson into title, lead and toned cards", () => {
    const doc = splitArticleSections(lesson);
    expect(doc.title).toBe("Équation du second degré");
    expect(doc.lead).toBe("On cherche les racines de $ax^2+bx+c=0$.");
    expect(doc.sections.map((section) => [section.heading, section.tone, section.children.length]))
      .toEqual([
        ["12. Erreurs fréquentes", "warning", 0],
        ["13. Résumé à retenir", "method", 3],
        ["Exercices", "exercise", 0],
        ["Réponses", "answer", 0],
      ]);
    expect(doc.sections[1]?.children.map((child) => child.heading)).toEqual([
      "Si Δ > 0",
      "Si Δ = 0",
      "Si Δ < 0",
    ]);
    expect(doc.sections[3]?.body).toBe("1. $S=\\{3;4\\}$");
  });

  test("keeps a heading-less body as lead", () => {
    expect(splitArticleSections("Juste un paragraphe.")).toEqual({
      title: null,
      lead: "Juste un paragraphe.",
      sections: [],
    });
  });

  test("ignores headings inside fences", () => {
    const doc = splitArticleSections("Intro\n\n```md\n## Pas une card\n```\n\n## Vraie card\nCorps");
    expect(doc.lead).toContain("## Pas une card");
    expect(doc.sections).toEqual([
      { heading: "Vraie card", level: 2, tone: "section", body: "Corps", children: [] },
    ]);
  });

  test("leaves the last section open while streaming", () => {
    const doc = splitArticleSections("# Titre\n\n## Erreurs fréquentes\nOublier");
    expect(doc.title).toBe("Titre");
    expect(doc.sections).toEqual([
      { heading: "Erreurs fréquentes", level: 2, tone: "warning", body: "Oublier", children: [] },
    ]);
  });

  const implicit = `Intro du cours.

12. Erreurs fréquentes
- oublier que a ≠ 0
- Si Δ < 0, dire « pas de solution réelle »

13. Résumé à retenir
1. Identifier a, b, c
2. Calculer Δ

Si Δ > 0 :
deux solutions

Si Δ = 0 :
une solution

Si Δ < 0 :
aucune

Exercices
1. x^2 - 7x + 12 = 0

Réponses :
1. S = {3 ; 4}
`;

  test("splits a model dump without ATX headings", () => {
    const doc = splitArticleSections(implicit);
    expect(doc.lead).toBe("Intro du cours.");
    expect(doc.sections.map((section) => [section.heading, section.tone, section.children.length]))
      .toEqual([
        ["12. Erreurs fréquentes", "warning", 0],
        ["13. Résumé à retenir", "method", 3],
        ["Exercices", "exercise", 0],
        ["Réponses", "answer", 0],
      ]);
    expect(doc.sections[0]?.body).toContain("Si Δ < 0, dire");
    expect(doc.sections[1]?.children.map((child) => child.heading)).toEqual([
      "Si Δ > 0",
      "Si Δ = 0",
      "Si Δ < 0",
    ]);
    expect(doc.sections[2]?.body).toContain("x^2 - 7x + 12 = 0");
  });
});

describe("splitAssistantCards", () => {
  const course = `Cours : les équations du second degré

Définition
Une équation du second degré s'écrit ax² + bx + c = 0.

Le discriminant
On calcule Δ = b² − 4ac.

Cas 1 : Δ > 0
Deux solutions.

Cas 2 : Δ = 0
Une solution.

Cas 3 : Δ < 0
Aucune solution réelle.

Méthode générale
On identifie a, b et c.

Étape 1 : identifier a, b et c
a = 2

Étape 2 : calculer Δ
Δ = 25

Exemple avec une seule solution
3x² − 12x + 12 = 0

Forme canonique
a(x − α)² + β

Exercices
1. x² − 7x + 12 = 0

Réponses :
1. S = {3 ; 4}
`;

  test("cuts a heading-less course into hoverable cards", () => {
    const { title, cards } = splitAssistantCards(course);
    expect(title).toBe("Cours : les équations du second degré");
    expect(cards.map((card) => card.title)).toEqual([
      "Définition",
      "Le discriminant",
      "Méthode générale",
      "Exemple avec une seule solution",
      "Forme canonique",
      "Exercices",
      "Réponses",
    ]);
    expect(cards.find((card) => card.title === "Le discriminant")?.markdown).toContain("### Cas 1 : Δ > 0");
    expect(cards.find((card) => card.title === "Méthode générale")?.markdown).toContain("### Étape 1 : identifier a, b et c");
    expect(cards.find((card) => card.title === "Réponses")?.tone).toBe("answer");
  });

  test("keeps a short reply as a single card", () => {
    const { title, cards } = splitAssistantCards("Oui, Δ = 25.");
    expect(title).toBeNull();
    expect(cards).toEqual([
      { id: "lead", title: null, markdown: "Oui, Δ = 25.", tone: "lead" },
    ]);
  });
});
