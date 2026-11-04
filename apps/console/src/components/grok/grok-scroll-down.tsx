import { GrokIcon } from "./grok-icons";

/** grok.com's « back to the latest » button: a raised 32 px circle centred above the composer. */
export function GrokScrollDown({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      data-thread-scroll-bottom=""
      className="grok-enter absolute bottom-2 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-[var(--grok-line)] bg-[var(--grok-raised)] text-[var(--grok-fg2)] outline-none transition-colors hover:text-[var(--grok-fg)] focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <GrokIcon name="chevron" className="size-4" />
    </button>
  );
}
