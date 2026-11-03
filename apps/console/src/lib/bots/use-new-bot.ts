import { useNavigate } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useBotDialogs } from "./bot-dialogs";

/**
 * « + » / « Nouveau bot » : au bureau, l'accueil `/` EST la création d'un bot
 * (`NewBotHome`), comme le « + » d'OpenBot ouvre sa page « Nouvel agent ».
 * Le bouton y mène, comme le bouton Accueil du rail, et met le nom sous le
 * curseur. Sur téléphone, l'accueil reste le salon : la feuille « Nouveau
 * bot » s'ouvre. La duplication d'un bot garde toujours la feuille.
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
