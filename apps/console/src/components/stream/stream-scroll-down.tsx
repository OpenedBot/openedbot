import { StreamIcon } from "./stream-icons";

/** the reference app's « back to the latest » button: a raised 32 px circle centred above the composer. */
export function StreamScrollDown({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      data-thread-scroll-bottom=""
      className="stream-enter absolute bottom-2 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-[var(--stream-line)] bg-[var(--stream-raised)] text-[var(--stream-fg2)] outline-none transition-colors hover:text-[var(--stream-fg)] focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <StreamIcon name="chevron" className="size-4" />
    </button>
  );
}
