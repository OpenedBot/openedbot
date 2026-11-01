"use client"

import * as React from "react"
import { CheckIcon, MinusIcon } from "lucide-react"
import { cn } from "../../lib/utils"

/* -------------------------------------------------------------------------- */
/*                             boardui primitives                             */
/* -------------------------------------------------------------------------- */

/* gray container card: bg surface, radius 16px, no border/shadow (boardui) */
export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-2xl bg-surface text-sm text-foreground", className)}>{children}</div>
}

/* delta / status pill: text-sm/500, rounded-md, px-1.5 py-0.5, NO icon */
export function Delta({
  value,
  tone,
  className,
}: {
  value: string
  tone: "pos" | "neg" | "flat"
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-sm font-medium tabular-nums leading-5",
        tone === "pos" && "bg-pos-100 text-pos-700",
        tone === "neg" && "bg-neg-100 text-neg-700",
        tone === "flat" && "bg-muted text-muted-foreground",
        className
      )}
    >
      {value}
    </span>
  )
}

/**
 * Reusable dropdown menu (filters + purchase + board team + account switcher).
 * Options are canonical ids; `labelFor` translates them at render, so selection
 * state never depends on the active locale.
 */
export function Menu<T extends string>({
  trigger,
  options,
  value,
  onSelect,
  labelFor,
  align = "start",
  width = 160,
  matchTrigger = false,
  fullWidth = false,
  leading,
}: {
  trigger: (open: boolean) => React.ReactNode
  options: readonly T[]
  value?: T
  onSelect: (v: T) => void
  labelFor?: (option: T) => string
  align?: "start" | "end"
  width?: number
  matchTrigger?: boolean
  fullWidth?: boolean
  leading?: (option: T) => React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [triggerW, setTriggerW] = React.useState<number>()
  const ref = React.useRef<HTMLDivElement>(null)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])
  const toggle = () => {
    if (!open && matchTrigger) setTriggerW(btnRef.current?.offsetWidth)
    setOpen((v) => !v)
  }
  return (
    <div className={cn("relative", fullWidth && "w-full")} ref={ref}>
      <button ref={btnRef} type="button" aria-expanded={open} onClick={toggle} className={cn(fullWidth && "w-full")}>
        {trigger(open)}
      </button>
      {open && (
        <div
          style={matchTrigger ? { width: triggerW } : { minWidth: width }}
          className={cn(
            "absolute z-40 mt-1.5 origin-top overflow-hidden rounded-xl border border-input bg-popover p-1 shadow-[var(--shadow-elevated)]",
            "animate-in fade-in-0 zoom-in-95 duration-150",
            align === "end" ? "right-0" : "left-0"
          )}
        >
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => {
                onSelect(o)
                setOpen(false)
              }}
              /* boardui dark: dropdown-item-hover = neutral-700 @ 60%, not solid accent */
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground/80 ohb-row hover:bg-accent/60"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {leading?.(o)}
                <span className="truncate">{labelFor ? labelFor(o) : o}</span>
              </span>
              {value === o && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Checkbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate?: boolean; onChange: () => void }) {
  const on = checked || indeterminate
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      onClick={onChange}
      className={cn(
        "flex size-4 items-center justify-center rounded-[5px] border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        on
          ? "border-primary bg-[image:var(--gradient-primary)] shadow-[inset_0_1px_0_0_#ffffff40]"
          : "border-input bg-card hover:border-muted-foreground"
      )}
    >
      {indeterminate ? <MinusIcon className="size-3 text-primary-foreground" strokeWidth={3} /> : checked ? <CheckIcon className="size-3 text-primary-foreground" strokeWidth={3} /> : null}
    </button>
  )
}
