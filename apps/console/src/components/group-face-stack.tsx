import type { BotFaceSpec } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { BotFace } from "./bot-face";

/**
 * The triangle's box, a notch and a half wider than a face: enough for
 * the three heads to overlap without hiding each other. Indexed on the sizes
 * callers actually pass; an unknown `size` falls back to the
 * `size-6` box.
 */
const CLUSTER_SIZE: Record<string, string> = {
  "size-5": "size-[30px]",
  "size-6": "size-9",
};

/**
 * The three seats of the « triopikeur » triangle: two heads behind, one
 * in front at the centre: a salon's visual identity where a DM has only one
 * face. With two members, the diagonal; past three, the front seat
 * goes to the « +N » chip rather than stretching the cluster.
 */
const TRIO_SLOTS = ["absolute left-0 top-0", "absolute right-0 top-0", "absolute bottom-0 left-1/2 z-10 -translate-x-1/2"] as const;
const DUO_SLOTS = ["absolute left-0 top-0", "absolute bottom-0 right-0 z-10"] as const;

export function GroupFaceStack({
  members,
  size = "size-6",
  max = 3,
  className,
}: {
  members: ReadonlyArray<{ id: string; name: string; face: BotFaceSpec | null }>;
  size?: string;
  max?: number;
  className?: string;
}) {
  // Three visible seats at most: when there is a remainder, the chip
  // « +N » takes the front seat instead of a third face.
  const withBadge = members.length > max;
  const shown = members.slice(0, withBadge ? Math.max(1, max - 1) : max);
  const rest = members.length - shown.length;
  const slots = shown.length + (withBadge ? 1 : 0) >= 3 ? TRIO_SLOTS : DUO_SLOTS;

  if (members.length === 1 && members[0]) {
    const only = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", className)}>
        <BotFace name={only.name} seed={only.id} face={only.face} className={cn(size, "rounded-full")} />
      </div>
    );
  }

  return (
    <div className={cn("relative shrink-0", CLUSTER_SIZE[size] ?? CLUSTER_SIZE["size-6"], className)}>
      {shown.map((member, index) => (
        <BotFace
          key={member.id}
          name={member.name}
          seed={member.id}
          face={member.face}
          className={cn(size, slots[index], "rounded-full")}
        />
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            size,
            slots[shown.length],
            "flex items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground",
          )}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}
