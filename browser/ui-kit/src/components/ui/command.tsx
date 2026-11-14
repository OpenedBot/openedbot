"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { CheckIcon, SearchIcon } from "lucide-react"

import { cn } from "../../lib/utils"
import { Dialog } from "./dialog"

/**
 * Command: the cmdk palette, ported from the onboarding reference.
 *
 * Two adaptations, both forced by what this package actually has:
 *
 *   - **`CommandInput` wraps its own bordered row** instead of the reference's
 *     `InputGroup`. We have no such primitive, and importing a whole input-group
 *     family to draw one border would be a bigger change than the border.
 *   - **`CommandDialog` sits on OUR `Dialog`**, which is one composite
 *     (`open` / `onClose` / `title` / …) rather than the shadcn
 *     `Dialog` + `DialogContent` + `DialogTitle` family the reference composes.
 *     Same job, our signature: the alternative was a second dialog
 *     implementation in the same package.
 */
function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  open,
  onClose,
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  description?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      className={cn("overflow-hidden rounded-xl! p-0", className)}
    >
      {children}
    </Dialog>
  )
}

function CommandInput({
  className,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 rounded-lg border border-input/30 bg-input/30 px-2"
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          // `min-h-11` : au doigt, la cible est le CHAMP, pas la boîte qui
          // l'entoure: il faisait 20 px de haut.
          "min-h-11 w-full bg-transparent text-body outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        onKeyDown={(event) => {
          // cmdk's root handler intercepts Home/End for list navigation;
          // stop propagation so the browser moves the text caret instead.
          if (event.key === "Home" || event.key === "End") {
            event.stopPropagation()
          }
          onKeyDown?.(event)
        }}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  scrollbar = "hidden",
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List> & {
  scrollbar?: "hidden" | "subtle"
}) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        scrollbar === "subtle" ? "scrollbar-subtle" : "no-scrollbar",
        "max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-body", className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-caption **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-muted data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      {/* The mark is always in the DOM and only revealed by `data-checked`, so
          a row does not change width when it becomes the chosen one. */}
      <CheckIcon className="ml-auto opacity-0 [[data-slot=command-shortcut]~&]:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-caption tracking-widest text-muted-foreground group-data-selected/command-item:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
