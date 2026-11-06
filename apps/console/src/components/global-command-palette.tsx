import { Suspense, useEffect, useRef, useState } from "react";
import { lazyRouteComponent, useNavigate } from "@tanstack/react-router";
import { useOpenedOnce } from "../lib/hooks/use-opened-once";

// The palette itself (cmdk, the search, every entry) is its own chunk, fetched
// on the first ⌘K: the frame only needs the shortcuts (ADR 0001, D1b).
const CommandPaletteDialog = lazyRouteComponent(() => import("./command-palette-dialog"), "CommandPaletteDialog");

/**
 * Palette globale des routes authentifiées.
 *
 * Les créations restent volontairement dans `BoardSidebar`: leurs états de
 * dialogue y sont privés. Les déclencher ici imposerait soit deux instances de
 * chaque formulaire, soit un clic DOM simulé sur un bouton éventuellement
 * replié. La palette ne fabrique aucun de ces deux couplages : elle navigue vers
 * les conversations et les pages sûres, jusqu'à ce que l'état des dialogues
 * soit remonté dans un contrôleur partagé.
 *
 * Ce composant ne tient que les raccourcis et l'état ouvert ; le contenu
 * (`command-palette-dialog.tsx`) se monte à la première ouverture.
 */
export function GlobalCommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  const mounted = useOpenedOnce(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        event.key.toLocaleLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      // Capture + stopImmediatePropagation neutralisent l'ancien raccourci du
      // filtre de roster sans toucher la sidebar. Dans un autre dialogue, le
      // raccourci est consommé mais n'empile jamais une seconde modale.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!openRef.current && document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      setOpen((current) => !current);
    };

    window.addEventListener("keydown", toggle, { capture: true });
    return () => window.removeEventListener("keydown", toggle, { capture: true });
  }, []);

  // ⌘⇧N / Ctrl+Shift+N : une nouvelle conversation de groupe, le raccourci de Grok Bot.
  useEffect(() => {
    const newGroupChat = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.altKey || !event.shiftKey || (!event.metaKey && !event.ctrlKey)) return;
      if (event.key.toLocaleLowerCase() !== "n") return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      void navigate({ to: "/g/new" });
    };
    window.addEventListener("keydown", newGroupChat);
    return () => window.removeEventListener("keydown", newGroupChat);
  }, [navigate]);

  return mounted ? (
    <Suspense fallback={null}>
      <CommandPaletteDialog open={open} setOpen={setOpen} />
    </Suspense>
  ) : null;
}
