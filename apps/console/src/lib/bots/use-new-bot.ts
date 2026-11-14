import { useNavigate } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useBotDialogs } from "./bot-dialogs";

/**
 * « + » / « Nouveau bot »: on desktop, the `/` home IS the creation of a bot
 * (`NewBotHome`), as the reference app's « + » opens its « Nouvel agent » page.
 * The button leads there, like the rail's Home button, and puts the name under the
 * cursor. On the phone, the home stays the room: the « Nouveau
 * bot » sheet opens. Duplicating a bot always keeps the sheet.
 */
export function useNewBot(): () => void {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const openCreate = useBotDialogs((state) => state.openCreate);
  return () => {
    if (isMobile) {
      openCreate();
      return;
    }
    // Already home: focus now. Elsewhere: the home focuses it once mounted.
    if (!focusNewBotName()) pendingNameFocus = true;
    void navigate({ to: "/" });
  };
}

let pendingNameFocus = false;

/** Puts the caret in the home's name field; `false` when it is not mounted. */
function focusNewBotName(): boolean {
  const name = document.querySelector<HTMLInputElement>("[data-new-bot-name]");
  if (!name) return false;
  name.focus({ preventScroll: true });
  name.select();
  return true;
}

/** Called by `NewBotHome` on mount: honours a « + » clicked from another screen. */
export function consumeNewBotNameFocus(): void {
  if (!pendingNameFocus) return;
  pendingNameFocus = false;
  focusNewBotName();
}
