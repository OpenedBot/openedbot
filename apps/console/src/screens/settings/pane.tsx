import type { ReactNode } from "react";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { MobileActionFooter } from "../../components/mobile/inset-grouped";
import { ACTIONS } from "../../components/settings/primitives";

/**
 * Le corps d'une page de réglages : le défileur, et les marges.
 *
 * Sur mobile la colonne est `overflow: hidden` : le contenu scrolle, les
 * CTA vivent dans `footer` (barre iOS `.bottomBar`), jamais dans le scroll
 * et jamais en `position: fixed`.
 */
export function SettingsPane({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) {
  const isMobile = useIsMobile();
  if (!isMobile) {
    return (
      <div data-settings-pane="" className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {/* `min-h-full` : un enfant `flex-1` (état vide, panne) peut alors se
            centrer dans la hauteur du défileur au lieu de coller à l'en-tête. */}
        <div className="flex min-h-full flex-col gap-8">
          {children}
          {footer ? <div className={ACTIONS}>{footer}</div> : null}
        </div>
      </div>
    );
  }
  return (
    <div
      data-mobile-settings=""
      data-has-action-footer={footer ? "" : undefined}
      className="flex min-h-0 flex-1 flex-col bg-[var(--ohb-grouped-canvas)]"
    >
      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-0 py-2">
        <div className="flex flex-col gap-2">{children}</div>
      </div>
      {footer ? <MobileActionFooter>{footer}</MobileActionFooter> : null}
    </div>
  );
}
