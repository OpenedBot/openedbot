import { cn } from "@openedbot/browser-ui-kit";

/** A status stays at least this long before the next replaces it (the reference app: 800 ms). */
export const THINKING_LABEL_HOLD_MS = 800;

/** the reference app's typing mark: three dots. */
const DOT_COUNT = 3;

/** the reference app's typing mark, three dots in the bot's colour (`.openedbot-thinking-dots`). */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden data-thinking-dots="" className={cn("openedbot-thinking-dots shrink-0", className)}>
      {Array.from({ length: DOT_COUNT }, (_, index) => <i key={index} />)}
    </span>
  );
}
