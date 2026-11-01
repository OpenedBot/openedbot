import { useState } from "react";

/**
 * True from the first render where `open` is true, and for good afterwards.
 *
 * Mount a closed dialog only once it has been opened: every sidebar row
 * carries its context menu's dialogs, and a closed dialog still runs its
 * hooks on each row render. Two of them (`BotGroupsDialog`,
 * `MoveToSectionDialog`) observe the roster, so every roster patch (the 202
 * of a send, the read receipt, each SSE flush) re-rendered them once per row
 * (OHB-141). Staying mounted after the first open keeps the exit transition.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
