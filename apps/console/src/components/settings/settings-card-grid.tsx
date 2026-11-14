import type { ReactNode } from "react";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";

/**
 * Desktop: short cards side by side according to the panel's width (a container
 * query, not the window): one column, two from `@4xl`, three from
 * `@[90rem]`, heights aligned per row. A long card stays out of the
 * grid, full width. On the phone, the children stay in the panel's
 * column. `trio`: three cards, three columns from `@6xl`, so as not to
 * leave the third alone on its row. See `DESIGN.md` › Bureau ›
 * Regrouper et aligner.
 */
export function SettingsCardGrid({ children, trio = false }: { children: ReactNode; trio?: boolean }) {
  const isMobile = useIsMobile();
  if (isMobile) return <>{children}</>;
  return (
    <div className="@container">
      <div className={cn("grid grid-cols-1 gap-6 @4xl:grid-cols-2 [&>*]:min-w-0", trio ? "@6xl:grid-cols-3" : "@[90rem]:grid-cols-3")}>{children}</div>
    </div>
  );
}
