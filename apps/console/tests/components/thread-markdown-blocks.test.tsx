import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  promoteSummaryCallout,
  ThreadMarkdown,
  ThreadMarkdownBlock,
} from "../../src/components/thread-markdown";
import { I18nProvider } from "../../src/lib/i18n";
import { splitMarkdownBlocks, stabilizeStreamingMarkdown } from "../../src/lib/streaming-markdown";

const DOCS = {
  answer: `Voici ce que j'ai trouvé.

Principes techniques :

- un **domaine** isolé
- des adaptateurs fins

\`\`\`ts
const x = 1;

export default x;
\`\`\`

Domain : entités, value objects et règles.

| a | b |
| - | - |
| 1 | 2 |

En résumé : ça tient.`,
  looseLists: `1. Premier

2. Deuxième
   suite indentée

   paragraphe du même élément

3. Troisième

- puce

* autre marqueur

Texte qui termine la liste.

- nouvelle liste`,
  nested: `1. Installer
   \`\`\`bash
   bun install

   bun test
   \`\`\`
2. Lancer

    code indenté

    encore du code

Fin.`,
  fencesAndMath: `~~~
tilde

fence
~~~

$$
a = b

c = d
$$

Texte avec $x$ et $$y$$ en ligne.

\`\`\`\`md
\`\`\`
interne
\`\`\`
\`\`\`\``,
  quotesAndHeadings: `# Titre

> [!NOTE] À savoir
> corps de l'encart

> citation simple

Sous-titre
---

***

## Deux

1. Ce qui tient
Les reference.md tiennent.`,
  heuristics: `/root
├── .hermes
│   ├── attachments
└── videos

src/
Domain/
tests/Unit/

Structure proposée :

Domain : entités.`,
  definitions: `Un [lien][doc] et une note[^1].

[doc]: https://example.com
[^1]: La note.`,
  html: `<details>

caché

</details>

après`,
  blankEdges: `

début


fin

`,
};

function render(node: React.ReactNode) {
  // `data-tick` alternates on every parse by design (it restarts the caret
  // blink): it is not part of the DOM shape compared here.
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>).replace(/ data-tick="\d"/g, "");
}

/**
 * Le rendu d'un seul tenant, tel que `ThreadMarkdown` le faisait avant la
 * découpe. En flux, la queue floue et le caret (« Stream Text ») suivent le
 * dernier texte : le même que celui du dernier bloc.
 */
function whole(markdown: string, streaming: boolean) {
  const source = streaming ? markdown : promoteSummaryCallout(markdown);
  return render(<ThreadMarkdownBlock markdown={source} tail={streaming} />);
}

function blocks(markdown: string, streaming: boolean) {
  return render(<ThreadMarkdown streaming={streaming}>{markdown}</ThreadMarkdown>);
}

describe("ThreadMarkdown par blocs", () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    test(`${name} : même DOM qu'un rendu d'un seul tenant`, () => {
      expect(blocks(doc, false)).toBe(whole(doc, false));
      expect(blocks(doc, true)).toBe(whole(doc, true));
    });
  }

  test("chaque préfixe du flux (texte stabilisé) rend le même DOM", () => {
    for (const doc of [DOCS.answer, DOCS.looseLists, DOCS.nested, DOCS.fencesAndMath, DOCS.quotesAndHeadings]) {
      for (let end = 1; end <= doc.length; end += 3) {
        const prefix = stabilizeStreamingMarkdown(doc.slice(0, end));
        expect(blocks(prefix, true)).toBe(whole(prefix, true));
      }
    }
  });

  test("les blocs terminés gardent leur texte quand le flux avance", () => {
    const first = splitMarkdownBlocks(stabilizeStreamingMarkdown(DOCS.answer.slice(0, 120)));
    const next = splitMarkdownBlocks(stabilizeStreamingMarkdown(DOCS.answer.slice(0, 200)));
    expect(first.length).toBeGreaterThan(2);
    expect(next.slice(0, first.length - 1)).toEqual(first.slice(0, -1));
  });

  test("on ne coupe ni une liste lâche, ni une fence, ni un bloc $$", () => {
    expect(splitMarkdownBlocks(DOCS.looseLists)).toEqual([
      "1. Premier\n\n2. Deuxième\n   suite indentée\n\n   paragraphe du même élément\n\n3. Troisième\n\n- puce\n\n* autre marqueur",
      "Texte qui termine la liste.",
      "- nouvelle liste",
    ]);
    expect(splitMarkdownBlocks(DOCS.fencesAndMath)).toHaveLength(4);
    expect(splitMarkdownBlocks(DOCS.definitions)).toEqual([DOCS.definitions]);
    expect(splitMarkdownBlocks("\n \n")).toEqual([]);
  });
});
