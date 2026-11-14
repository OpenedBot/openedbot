import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import { drawnMermaid, keepMermaid } from "../lib/stream/mermaid-drawings";
import { mermaidConfig } from "../lib/stream/mermaid-theme";

/** The app's theme, read from the root `.dark` class: no provider needed, follows a live switch. */
function subscribeDarkClass(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
const darkClass = () => document.documentElement.classList.contains("dark");

export function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/:/gu, "");
  const dark = useSyncExternalStore(subscribeDarkClass, darkClass, () => false);
  // Read while rendering: a row mounted back by scrolling shows its drawing at once
  // (`mermaid-drawings.ts`). The state below only asks for the render that follows a drawing.
  const svg = drawnMermaid(source, dark);
  const [, setDrawnCount] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const drawingKey = `${dark}\n${source}`;

  useEffect(() => {
    if (drawnMermaid(source, dark) !== null) return;
    let cancelled = false;
    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize(mermaidConfig(dark));
        return mermaid.render(`openedbot-mermaid-${id}-${dark ? "d" : "l"}`, source);
      })
      .then(({ svg: rendered }) => {
        // Kept even when this row is already gone: it is there when the row comes back.
        keepMermaid(source, dark, rendered);
        if (!cancelled) setDrawnCount((count) => count + 1);
      })
      .catch(() => {
        // Invalid or incomplete input keeps its readable source and releases initial layout.
        if (!cancelled) setFailed(`${dark}\n${source}`);
      });
    return () => {
      cancelled = true;
    };
  }, [id, source, dark]);

  if (!svg) {
    return (
      <pre data-thread-layout-pending={failed === drawingKey ? undefined : ""} className="scrollbar-subtle not-prose my-2 max-w-full overflow-x-auto whitespace-pre rounded-lg border border-border/50 bg-surface-sunken/60 p-3 font-mono text-xs leading-5 text-foreground">
        {source}
      </pre>
    );
  }
  return <MermaidSvg svg={svg} />;
}

/**
 * A drawn diagram. A click (or Enter) opens it large, like an image of the
 * thread (thread-image-dialog.tsx). The drawing is vector: it fills the
 * dialog without blurring, whatever its size in the bubble.
 */
export function MermaidSvg({ svg }: { svg: string }) {
  const [enlarged, setEnlarged] = useState(false);
  const { t } = useT();
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={t("threadTimeline.mermaidEnlarge")}
        title={t("threadTimeline.mermaidEnlarge")}
        onClick={() => setEnlarged(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setEnlarged(true);
          }
        }}
        className="scrollbar-subtle not-prose my-2 max-w-full cursor-zoom-in overflow-x-auto rounded-lg border border-border/50 bg-surface-sunken/60 p-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-auto [&_svg]:max-w-full"
      >
        <div role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      <Dialog
        open={enlarged}
        onClose={() => setEnlarged(false)}
        title={t("threadTimeline.mermaidDiagram")}
        closeLabel={t("common.close")}
        className="h-[85vh] max-h-none w-[85vw] max-w-none"
        bodyClassName="flex min-h-0 items-center justify-center overflow-auto p-4"
      >
        <div
          role="img"
          aria-label="Mermaid diagram"
          className="flex h-full w-full items-center justify-center text-foreground [&_svg]:!h-full [&_svg]:!max-h-full [&_svg]:!w-full [&_svg]:!max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </Dialog>
    </>
  );
}
