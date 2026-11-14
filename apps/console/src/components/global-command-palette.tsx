import { Suspense, useEffect, useRef, useState } from "react";
import { lazyRouteComponent, useNavigate } from "@tanstack/react-router";
import { useOpenedOnce } from "../lib/hooks/use-opened-once";

// The palette itself (cmdk, the search, every entry) is its own chunk, fetched
// on the first ⌘K: the frame only needs the shortcuts.
const CommandPaletteDialog = lazyRouteComponent(() => import("./command-palette-dialog"), "CommandPaletteDialog");

/**
 * Global palette of the authenticated routes.
 *
 * Creations stay deliberately in `BoardSidebar`: their dialog
 * states are private there. Triggering them here would impose either two instances of
 * each form, or a simulated DOM click on a button that may be
 * folded. The palette builds neither of those two couplings: it navigates to
 * the conversations and the safe pages, until the dialogs' state
 * is lifted into a shared controller.
 *
 * This component holds only the shortcuts and the open state; the content
 * (`command-palette-dialog.tsx`) mounts on the first opening.
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

      // Capture + stopImmediatePropagation neutralize the old shortcut of the
      // roster filter without touching the sidebar. Inside another dialog, the
      // shortcut is consumed but never stacks a second modal.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!openRef.current && document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      setOpen((current) => !current);
    };

    window.addEventListener("keydown", toggle, { capture: true });
    return () => window.removeEventListener("keydown", toggle, { capture: true });
  }, []);

  // ⌘⇧N / Ctrl+Shift+N: a new group conversation, the reference app's shortcut.
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
