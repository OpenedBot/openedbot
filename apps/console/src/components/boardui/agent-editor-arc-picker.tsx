import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";

/** The nine slots of the shape arc (offsets measured on the target, in px). */
const SHAPE_SLOTS: ReadonlyArray<[number, number]> = [
  [-205.35, -132.06],
  [-178.94, -66.09],
  [-132.05, -12.71],
  [-70.03, 21.98],
  [0, 34],
  [70.03, 21.98],
  [132.05, -12.71],
  [178.94, -66.09],
  [205.35, -132.06],
];

/** The bottom arc: the chosen item in the centre, its neighbours on either side. */
export function ArcPicker<T extends { id: string }>({
  label,
  items,
  selectedId,
  itemLabel,
  onPick,
  renderItem,
}: {
  label: string;
  items: readonly T[];
  selectedId: string | undefined;
  itemLabel: (item: T) => string;
  onPick: (item: T) => void;
  renderItem: (item: T) => ReactNode;
}) {
  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const arc = SHAPE_SLOTS.map((slot, slotIndex) => {
    const offset = slotIndex - 4;
    if (offset < -Math.floor(items.length / 2) || offset > Math.ceil(items.length / 2) - 1) return null;
    const item = items[(selectedIndex + offset + items.length) % items.length]!;
    return { slot, item, selected: offset === 0 };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0">
      <div
        role="listbox"
        aria-label={label}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.key === "ArrowRight" ? 1 : -1;
          onPick(items[(selectedIndex + step + items.length) % items.length]!);
        }}
        className="pointer-events-auto relative h-[126px] w-full touch-pan-y overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
        style={{
          maskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
          clipPath: "polygon(0 0, 15% 0, 30% 36%, 50% 50%, 70% 36%, 85% 0, 100% 0, 100% 100%, 0 100%)",
        }}
      >
        {arc.map(({ slot, item, selected }) => {
          const name = itemLabel(item);
          return (
            <div
              key={`${item.id}:${slot[0]}`}
              className="pointer-events-auto absolute top-[35px] left-1/2 -ml-7 size-14 transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{ transform: `translate(${slot[0]}px, ${slot[1]}px)` }}
            >
              <button
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={name}
                title={name}
                tabIndex={-1}
                onClick={() => onPick(item)}
                className={cn(
                  "flex size-14 cursor-pointer items-center justify-center rounded-[16px] outline-none transition-colors hover:bg-background-secondary-default",
                  selected && "bg-background-secondary-default ring-1 ring-border-button-default",
                )}
              >
                {renderItem(item)}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
