/**
 * `/dev/math` (dev only, mounted by `route-tree.tsx` under
 * `import.meta.env.DEV === true`): the math + mermaid fixture rendered by the
 * thread markdown, for a visual check after a KaTeX or mermaid upgrade.
 * Nothing here calls the API or a runtime.
 */
import { ThreadMarkdown } from "../../components/thread-markdown";
import { MATH_MERMAID_FIXTURE } from "../../lib/dev/math-mermaid-fixture";

export function MathLabScreen() {
  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto px-6 py-8">
      <ThreadMarkdown>{MATH_MERMAID_FIXTURE}</ThreadMarkdown>
    </div>
  );
}
