import { useEffect, useRef, useState } from "react";
import { applyPreview, checkLayout, type LayoutCheck, type Locale, type PreviewState, type Theme } from "../lib/preview";
import { useRevision } from "../lib/live";

type Props = {
  template: string;
  theme: Theme;
  locale: Locale;
  state: PreviewState;
  /** The simulated window size, in CSS pixels. */
  width: number;
  height: number;
  /** Width the preview may take on screen; the window is scaled down to it. */
  fitWidth: number;
  /** Lets the page interact with the form (focus, typing) instead of a picture. */
  interactive?: boolean;
  onChecks?: (checks: LayoutCheck[]) => void;
};

/**
 * One live preview: the real signin.html at a real window size, scaled to
 * fit. Re-applies options in place; reloads only when the markup changes.
 */
export function Preview({ template, theme, locale, state, width, height, fitWidth, interactive = false, onChecks }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(0);
  const revision = useRevision();
  const scale = Math.min(1, fitWidth / width);

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    const win = frame.current?.contentWindow;
    if (!doc || !win || !doc.body) return;
    applyPreview(doc, { template, theme, locale, state, revision: revision.styles });
    if (!onChecks) return;
    // Measure once the stylesheet has landed and the layout settled.
    let cancelled = false;
    const measure = (attempt: number): void => {
      if (cancelled) return;
      if (!doc.documentElement.hasAttribute("data-ready") && attempt < 40) {
        win.setTimeout(() => measure(attempt + 1), 50);
        return;
      }
      win.requestAnimationFrame(() => {
        if (!cancelled) onChecks(checkLayout(win));
      });
    };
    measure(0);
    return () => {
      cancelled = true;
    };
  }, [template, theme, locale, state, revision.styles, loaded, onChecks, width, height]);

  return (
    <div className="preview" style={{ width: width * scale, height: height * scale }}>
      <iframe
        key={revision.page}
        ref={frame}
        title={`${template} ${theme}`}
        src={`/signin.html?template=${template}`}
        width={width}
        height={height}
        style={{ transform: `scale(${scale})`, pointerEvents: interactive ? "auto" : "none" }}
        onLoad={() => setLoaded((value) => value + 1)}
      />
    </div>
  );
}
