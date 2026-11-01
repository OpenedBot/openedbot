/**
 * Thread lab answer (dev only): one markdown setup, four ways to let the
 * streamed text arrive. `smooth` is what the console ships today.
 */
import { Fragment, memo } from "react";
import Markdown, { type Options } from "react-markdown";
import { splitMarkdownBlocks } from "../../../lib/stream/streaming-markdown";
import { useSmoothText } from "../../../lib/stream/use-smooth-text";
import { rehypeLabWords } from "../../../lib/dev/thread-lab-rehype";
import { rehypeStreamTail } from "../../../lib/stream/stream-tail-rehype";
import { ThreadMarkdown, threadMarkdownSetup } from "../../thread-markdown";

export type LabTextMode = "smooth" | "instant" | "words" | "tail";

export const LAB_TEXT_MODES: ReadonlyArray<{ value: LabTextMode; label: string }> = [
  { value: "smooth", label: "Lissé (actuel)" },
  { value: "instant", label: "Brut, par fragment" },
  { value: "words", label: "Mots en fondu flou" },
  { value: "tail", label: "Queue floue + caret" },
];

/**
 * The current bubble's prose (`thread-messages.tsx`) with Pulseview's reading
 * rhythm: 24 px lines, roomier headings, no bubble around the answer.
 */
const LAB_PROSE = "ai-response-reveal prose max-w-none min-w-0 wrap-anywhere text-body-regular text-text-primary [--tw-prose-body:var(--bui-text-primary)] [--tw-prose-headings:var(--bui-text-primary)] [--tw-prose-bold:var(--bui-text-primary)] [--tw-prose-links:var(--bui-text-primary)] dark:prose-invert prose-headings:font-semibold prose-headings:tracking-tight prose-headings:mt-6 prose-headings:mb-2 prose-h2:text-[17px] prose-h3:text-[15px] prose-p:my-0 prose-p:leading-6 prose-ul:my-0 prose-ol:my-0 prose-li:my-1 prose-li:leading-6 [&>*+*]:mt-3 prose-li:marker:text-text-tertiary prose-pre:my-4 prose-strong:font-semibold prose-code:rounded prose-code:bg-background-tertiary-hover/60 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none [&>:first-child]:mt-0 [&>:last-child]:mb-0";

// Stable identities: a block re-parses only when its own text changes.
type RehypePlugins = NonNullable<Options["rehypePlugins"]>;
const PLAIN: RehypePlugins = [...threadMarkdownSetup.rehypePlugins];
const WORDS: RehypePlugins = [...threadMarkdownSetup.rehypePlugins, rehypeLabWords];
const TAIL: RehypePlugins = [...threadMarkdownSetup.rehypePlugins, rehypeStreamTail];

const LabBlock = memo(function LabBlock({ markdown, plugins }: { markdown: string; plugins: RehypePlugins }) {
  return (
    <Markdown remarkPlugins={threadMarkdownSetup.remarkPlugins} rehypePlugins={plugins} components={threadMarkdownSetup.components}>
      {markdown}
    </Markdown>
  );
});

export function LabAnswer({ text, live, mode }: { text: string; live: boolean; mode: LabTextMode }) {
  const smoothed = useSmoothText(text, live && mode !== "instant");
  const shown = mode === "instant" ? text : smoothed;

  if (mode === "smooth" || mode === "instant") {
    return (
      <div className={LAB_PROSE}>
        <ThreadMarkdown streaming={live}>{shown}</ThreadMarkdown>
      </div>
    );
  }

  // Block by block, like `ThreadMarkdown`: settled blocks keep their DOM, so
  // a word that already played its entrance never plays it again.
  const blocks = splitMarkdownBlocks(shown);
  return (
    <div className={LAB_PROSE} data-lab-text={mode}>
      {blocks.map((block, index) => (
        <Fragment key={index}>
          {index > 0 ? "\n" : null}
          <LabBlock
            markdown={block}
            plugins={mode === "words" ? WORDS : live && index === blocks.length - 1 ? TAIL : PLAIN}
          />
        </Fragment>
      ))}
    </div>
  );
}
