import type { BotFaceSpec } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { BotFace } from "./bot-face";

/**
 * La boîte du triangle, un cran et demi plus large qu'un visage : assez pour
 * que les trois têtes se chevauchent sans se cacher. Indexée sur les tailles
 * réellement passées par les appelants ; un `size` inconnu retombe sur la
 * boîte de `size-6`.
 */
const CLUSTER_SIZE: Record<string, string> = {
  "size-5": "size-[30px]",
  "size-6": "size-9",
};

/**
 * Les trois places du triangle « triopikeur » : deux têtes derrière, une
 * devant au centre : l'identité visuelle d'un salon là où un DM n'a qu'un
 * visage. À deux membres, la diagonale ; au-delà de trois, la place de devant
 * revient à la pastille « +N » plutôt que d'étirer la grappe.
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
  // Trois places visibles au plus : quand il y a du reliquat, la pastille
  // « +N » occupe la place de devant à la place d'un troisième visage.
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
