import type { ReactNode } from "react";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { MobileActionFooter } from "../../components/mobile/inset-grouped";
import { ACTIONS } from "../../components/settings/primitives";

/**
 * The body of a settings page: the scroller, and the margins.
 *
 * On mobile the column is `overflow: hidden`: the content scrolls, the
 * CTAs live in `footer` (iOS bar `.bottomBar`), never in the scroll
 * and never in `position: fixed`.
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
        {/* `min-h-full`: a `flex-1` child (empty state, failure) can then
            center in the scroller's height instead of sticking to the header. */}
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
      className="flex min-h-0 flex-1 flex-col bg-[var(--openedbot-grouped-canvas)]"
    >
      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-0 py-2">
        <div className="flex flex-col gap-2">{children}</div>
      </div>
      {footer ? <MobileActionFooter>{footer}</MobileActionFooter> : null}
    </div>
  );
}
