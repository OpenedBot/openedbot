/**
 * Cost of a stream update on a long reply: a single
 * `react-markdown` over the whole text (before) against per-block rendering
 * (after), in the tests' happy-dom DOM.
 *
 *   bun apps/console/tests/components/thread-markdown.bench.tsx
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("../../src/lib/i18n");
const { ThreadMarkdown, ThreadMarkdownBlock } = await import("../../src/components/thread-markdown");
const { stabilizeStreamingMarkdown } = await import("../../src/lib/stream/streaming-markdown");

const SECTION = (index: number) => `## Partie ${index}

Principes techniques :

- un **domaine** isolé, sans dépendance vers l'infrastructure
- des adaptateurs fins, testés contre de vraies bases

\`\`\`ts
export const value${index} = compute(${index});

export default value${index};
\`\`\`

Domain : entités, value objects et règles, avec un [lien](https://example.com/${index}) et du \`code\`.

| colonne | valeur |
| - | - |
| a | ${index} |

`;

const STEP = 40;

function median(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function run(label: string, text: string, render: (markdown: string) => React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const samples: number[] = [];
  for (let end = STEP; end <= text.length; end += STEP) {
    const markdown = stabilizeStreamingMarkdown(text.slice(0, end));
    const start = performance.now();
    flushSync(() => root.render(<I18nProvider>{render(markdown)}</I18nProvider>));
    samples.push(performance.now() - start);
  }
  root.unmount();
  container.remove();
  const tail = samples.slice(-Math.ceil(samples.length / 4));
  console.log(`${label.padEnd(18)} median ${median(samples).toFixed(2).padStart(7)} ms   dernier quart ${median(tail).toFixed(2).padStart(7)} ms   (${samples.length} mises à jour)`);
}

for (const sections of [2, 8, 20]) {
  const text = Array.from({ length: sections }, (_, index) => SECTION(index)).join("");
  console.log(`\nréponse de ${text.length} caractères, une mise à jour tous les ${STEP} caractères`);
  run("un seul parse", text, (markdown) => <ThreadMarkdownBlock markdown={markdown} />);
  run("par blocs", text, (markdown) => <ThreadMarkdown streaming>{markdown}</ThreadMarkdown>);
}
