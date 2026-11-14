"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "../../lib/utils"

type TriggerArgs = {
  ref: (el: HTMLElement | null) => void
  onClick: () => void
  "aria-expanded": boolean
}

type PopoverProps = {
  trigger: (args: TriggerArgs) => React.ReactNode
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
  align?: "start" | "end"
  /** Which side of the trigger the panel opens on. "top" is useful for triggers near the viewport bottom, "right" for triggers inside a sidebar. */
  side?: "bottom" | "top" | "right"
  width?: number
  className?: string
}

/* anchored dropdown panel (portal, fixed): opens below (or above) the trigger, closes on outside click / Escape */
export function Popover({ trigger, children, align = "end", side = "bottom", width = 288, className }: PopoverProps) {
  const [open, setOpen] = React.useState(false)
  const [shown, setShown] = React.useState(false)
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; left?: number; right?: number }>({ top: 0 })
  const anchorRef = React.useRef<HTMLElement | null>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const setAnchor = React.useCallback((el: HTMLElement | null) => {
    anchorRef.current = el
  }, [])

  const close = React.useCallback(() => {
    setShown(false)
    window.setTimeout(() => setOpen(false), 150)
  }, [])

  const place = React.useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // clientWidth/Height exclude the scrollbar; innerWidth would shift a right-anchored panel off by the scrollbar width
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    // "right" opens beside the trigger, aligned to its top edge
    if (side === "right") {
      setPos({ top: Math.max(8, r.top), left: Math.max(8, Math.min(r.right + 8, vw - width - 8)) })
      return
    }
    // vertical anchor: "top" grows the panel upward from just above the trigger (no height measurement needed)
    const v = side === "top" ? { bottom: Math.max(8, vh - r.top + 8) } : { top: r.bottom + 8 }
    if (align === "end") setPos({ ...v, right: Math.max(8, vw - r.right) })
    else setPos({ ...v, left: Math.max(8, Math.min(r.left, vw - width - 8)) })
  }, [align, side, width])

  const toggle = () => {
    if (open) {
      close()
      return
    }
    place()
    setOpen(true)
    requestAnimationFrame(() => setShown(true))
  }

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    window.addEventListener("resize", place)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", place)
    }
  }, [open, close, place])

  return (
    <>
      {/* eslint-disable-next-line react-hooks/refs -- setAnchor is a stable callback ref, no .current read during render */}
      {trigger({ ref: setAnchor, onClick: toggle, "aria-expanded": open })}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right, width, maxWidth: "calc(100vw - 16px)" }}
            className={cn(
              "z-[110] overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-elevated)] transition duration-150 ease-out",
              side === "right"
                ? "origin-top-left"
                : side === "top"
                  ? align === "end"
                    ? "origin-bottom-right"
                    : "origin-bottom-left"
                  : align === "end"
                    ? "origin-top-right"
                    : "origin-top-left",
              shown ? "scale-100 opacity-100 blur-0" : "scale-95 opacity-0 blur-[2px]",
              className
            )}
          >
            {typeof children === "function" ? children(close) : children}
          </div>,
          document.body
        )}
    </>
  )
}
