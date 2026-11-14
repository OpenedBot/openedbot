"use client"

import * as React from "react"
import { BellIcon, CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react"
import { cn } from "../../lib/utils"

export type AlertVariant = "default" | "info" | "success" | "warning" | "error"

/* tinted callout per semantic role (boardui color families) */
const VARIANT: Record<AlertVariant, { Icon: LucideIcon; wrap: string; icon: string }> = {
  default: { Icon: BellIcon, wrap: "border-border bg-card", icon: "text-muted-foreground" },
  info: { Icon: InfoIcon, wrap: "border-info-100 bg-info-soft", icon: "text-info-700" },
  success: { Icon: CircleCheckIcon, wrap: "border-pos-100 bg-pos-soft", icon: "text-pos-700" },
  warning: { Icon: TriangleAlertIcon, wrap: "border-warn-100 bg-warn-soft", icon: "text-warn-700" },
  error: { Icon: CircleXIcon, wrap: "border-neg-100 bg-neg-soft", icon: "text-neg-700" },
}

export function Alert({
  variant = "default",
  title,
  icon,
  meta,
  children,
  className,
}: {
  variant?: AlertVariant
  title?: React.ReactNode
  icon?: LucideIcon
  meta?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  const v = VARIANT[variant]
  const Icon = icon ?? v.Icon
  return (
    <div role="alert" className={cn("flex items-start gap-3 rounded-xl border p-3", v.wrap, className)}>
      <Icon className={cn("mt-0.5 size-5 shrink-0", v.icon)} />
      <div className="min-w-0 flex-1">
        {(title || meta) && (
          <div className="flex items-center justify-between gap-2">
            {title && <p className="truncate text-sm font-medium text-foreground">{title}</p>}
            {meta && <span className="shrink-0 text-xs text-muted-foreground/70">{meta}</span>}
          </div>
        )}
        {children && <div className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{children}</div>}
      </div>
    </div>
  )
}
