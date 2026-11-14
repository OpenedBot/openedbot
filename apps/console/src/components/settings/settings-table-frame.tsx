import type { ComponentProps, ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { ACTIONS, CARD_DESCRIPTION, CARD_TITLE, SETTINGS_INSET, SETTINGS_SHELL, SETTINGS_SHELL_HEADER } from "./primitives";

/**
 * A desktop data table set in the settings card: the title (and its action)
 * on the tray, then the card holding an optional toolbar (search, filters)
 * above the table. Without a title it is the tray alone around the card.
 */
export function SettingsTableFrame({
  children,
  title,
  description,
  action,
  toolbar,
  className,
  ...rest
}: {
  children: ReactNode;
  title?: string;
  description?: ReactNode;
  /** The table's gesture (import, export), on the tray, right of the title. */
  action?: ReactNode;
  /** Search or filters, at the top of the card, above the column band. */
  toolbar?: ReactNode;
  className?: string;
} & Omit<ComponentProps<"div">, "children" | "className" | "title">) {
  return (
    <div data-settings-table="" className={SETTINGS_SHELL} {...rest}>
      {title ? (
        <div className={cn("flex flex-wrap items-start justify-between gap-3", SETTINGS_SHELL_HEADER)}>
          <div className="min-w-0">
            <h2 className={CARD_TITLE}>{title}</h2>
            {description ? <p className={CARD_DESCRIPTION}>{description}</p> : null}
          </div>
          {action ? <div className={`shrink-0 ${ACTIONS}`}>{action}</div> : null}
        </div>
      ) : null}
      <div className={SETTINGS_INSET}>
        {toolbar ? <div className="border-b border-border/60 p-2.5">{toolbar}</div> : null}
        <div className={cn("min-w-0", className)}>{children}</div>
      </div>
    </div>
  );
}
