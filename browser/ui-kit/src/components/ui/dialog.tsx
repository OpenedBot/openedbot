"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { XIcon } from "lucide-react"
import { cn } from "../../lib/utils"
import { useIsMobile } from "../../hooks/use-mobile"
import { SHEET_SETTLE_TRANSITION, useSheetDismissDrag } from "../../hooks/use-sheet-dismiss"

type DialogProps = {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  className?: string
  /** Classes du fond : `backdrop-blur-sm` pour une alerte qui floute la page. */
  overlayClassName?: string
  /** Classes du corps (la zone qui défile) : `p-0` pour un contenu plein-bord qui gère sa propre mise en page. */
  bodyClassName?: string
  /** Classes du pied : pour une rangée qui wrap ou une grille, pas une ligne qui déborde. */
  footerClassName?: string
  showClose?: boolean
  role?: "dialog" | "alertdialog"
  closeLabel?: string
  /** Nom accessible quand la boîte n'a pas de `title` (mise en page plein-bord qui rend son propre en-tête). */
  ariaLabel?: string
  /** Id de la description que rend un en-tête maison, quand la boîte n'a pas de `description`. */
  ariaDescribedBy?: string
  /** Poignée de feuille mobile. `false` sur une feuille Inset Grouped (✕ en pastille). */
  showHandle?: boolean
  /**
   * La feuille se referme au balayage vers le bas. Vrai par défaut : c'est le
   * geste que tout le monde essaie en premier sur un téléphone, et l'absence
   * de réponse est ce qui fait chercher la croix.
   *
   * `false` sur une décision, pas sur une lecture : une confirmation
   * destructive se tranche par un bouton : un balayage qui « annule » est une
   * réponse qu'on n'a pas voulu donner.
   */
  swipeToDismiss?: boolean
  /**
   * Déplace le focus dans la boîte à l'ouverture. Les feuilles d'actions
   * ouvertes par un geste tactile peuvent le désactiver pour ne pas fabriquer
   * un focus clavier à partir d'un appui long.
   */
  autoFocus?: boolean
}

export const DialogContextLabel = React.createContext<string | null>(null)

const EXIT_MS = 150

/**
 * Les boîtes montées, du fond vers le dessus.
 *
 * Une boîte peut en ouvrir une autre (installer une entrée du catalogue par
 * dessus la liste des connecteurs), et les deux écoutent `keydown` sur
 * `document`. Sans pile, Escape les ferme toutes les deux : `stopPropagation`
 * n'arrête pas l'autre écouteur du MÊME nœud : et le piège à Tab de celle du
 * dessous ramène le focus dans une boîte que l'utilisateur ne voit plus. Seule
 * celle du dessus répond donc au clavier.
 */
const stack: symbol[] = []

/**
 * Verrou de défilement partagé par toutes les boîtes ouvertes. Chacune prend
 * une part ; la valeur d'origine n'est rendue qu'à la dernière libération,
 * quel que soit l'ordre de fermeture. Une sauvegarde locale par boîte
 * supposait une fermeture strictement inverse de l'ouverture.
 */
let scrollLockOwners = 0
let scrollLockRestore = ""

export function lockBodyScroll(body: { style: { overflow: string } } = document.body): () => void {
  if (scrollLockOwners === 0) {
    scrollLockRestore = body.style.overflow
    body.style.overflow = "hidden"
  }
  scrollLockOwners += 1
  let released = false
  return () => {
    if (released) return
    released = true
    scrollLockOwners -= 1
    if (scrollLockOwners === 0) body.style.overflow = scrollLockRestore
  }
}
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

export function Dialog({ open, onClose, title, description, children, footer, className, overlayClassName, bodyClassName, footerClassName, showClose = true, showHandle = true, swipeToDismiss = true, autoFocus = true, role = "dialog", closeLabel = "Close dialog", ariaLabel, ariaDescribedBy }: DialogProps) {
  const contextLabel = React.useContext(DialogContextLabel)
  const isMobile = useIsMobile()
  const [render, setRender] = React.useState(open)
  const [shown, setShown] = React.useState(false)
  const titleId = React.useId()
  const descriptionId = React.useId()
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const previousFocusRef = React.useRef<HTMLElement | null>(null)
  const onCloseRef = React.useRef(onClose)
  const idRef = React.useRef<symbol>(undefined as unknown as symbol)
  if (idRef.current === undefined) idRef.current = Symbol("dialog")

  React.useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // enter / exit lifecycle: mount → next frame fade/scale in; on close, fade out then unmount.
  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount before the enter transition
      setRender(true)
      const id = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const t = window.setTimeout(() => setRender(false), EXIT_MS)
    return () => window.clearTimeout(t)
  }, [open])

  // Focus ownership, keyboard containment and body scroll lock while mounted.
  React.useEffect(() => {
    if (!render) return

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    // Focus lands on the dialog container, not on its first control: WebKit
    // matches :focus-visible on programmatic focus, so grabbing a button here
    // painted a focus ring on a mouse-driven open. Opt a control in with
    // `data-dialog-autofocus` when it genuinely deserves the ring (a text field
    // to type in); a confirmation's buttons do not.
    const focusFrame = autoFocus
      ? requestAnimationFrame(() => {
          const dialog = dialogRef.current
          if (!dialog) return
          const preferred = dialog.querySelector<HTMLElement>("[data-dialog-autofocus]")
          ;(preferred ?? dialog).focus()
        })
      : null

    const onKey = (e: KeyboardEvent) => {
      // Une boîte recouverte par une autre ne répond plus au clavier : c'est
      // celle du dessus que l'utilisateur voit et croit piloter.
      if (stack[stack.length - 1] !== idRef.current) return
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== "Tab") return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((element) => element.getClientRects().length > 0)

      if (focusable.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }

      // The empty case returned above, so both ends exist : assert it rather
      // than branch, so the trap keeps exactly one exit path.
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      // `active === dialog` is the open state above: Shift+Tab from the
      // container would otherwise walk out of the portal instead of wrapping.
      if (e.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    stack.push(idRef.current)
    document.addEventListener("keydown", onKey)
    const releaseScroll = lockBodyScroll()
    return () => {
      const at = stack.lastIndexOf(idRef.current)
      if (at !== -1) stack.splice(at, 1)
      if (focusFrame !== null) cancelAnimationFrame(focusFrame)
      document.removeEventListener("keydown", onKey)
      releaseScroll()
      const previousFocus = previousFocusRef.current
      previousFocusRef.current = null
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [autoFocus, render])

  // Le geste vit ici et non dans un wrapper : il lui faut la feuille elle-même
  // (sa hauteur, ses défileurs) et le `onClose` de l'appelant.
  const swipe = useSheetDismissDrag({
    enabled: render && open && isMobile && swipeToDismiss,
    onClose,
    sheetRef: dialogRef,
  })

  if (!render) return null

  return createPortal(
    <div
      className={cn(
        // Sur un téléphone la boîte devient une feuille ancrée en bas : via
        // `useIsMobile`, pas `max-sm` : un iPhone en paysage reste une feuille.
        "fixed inset-0 z-[110] flex bg-black/50 transition-opacity duration-150",
        isMobile ? "items-end p-0" : "items-center justify-center p-4",
        shown ? "opacity-100" : "opacity-0",
        overlayClassName
      )}
      style={
        swipe.offset === null
          ? undefined
          : { opacity: 1 - swipe.progress, transition: swipe.dragging ? "none" : "opacity 300ms cubic-bezier(0.32, 0.72, 0, 1)" }
      }
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        data-slot="dialog-content"
        role={role}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? ariaLabel : undefined}
        aria-describedby={description ? descriptionId : ariaDescribedBy}
        onClick={(e) => e.stopPropagation()}
        {...swipe.handlers}
        style={
          swipe.offset === null
            ? undefined
            : {
                transform: `translate3d(0, ${swipe.offset}px, 0)`,
                transition: swipe.dragging ? "none" : SHEET_SETTLE_TRANSITION,
                willChange: "transform",
              }
        }
        className={cn(
          // `outline-none` : le conteneur reçoit le focus à l'ouverture (voir
          // l'effet plus haut), et l'anneau par défaut du navigateur
          // entourerait toute la boîte de dialogue.
          "flex w-full flex-col overflow-hidden outline-none transition duration-150 ease-out",
          isMobile
            ? "openedbot-inset-sheet max-h-[calc(100dvh-var(--openedbot-safe-top)-2.5rem)] max-w-none pb-[var(--openedbot-safe-bottom)] duration-250"
            : "max-h-[calc(100dvh-4rem)] max-w-[480px] rounded-xl border border-foreground/12 bg-card text-[13px] leading-[18px] shadow-[var(--shadow-elevated)] dark:bg-surface",
          shown ? "translate-y-0 scale-100 opacity-100" : isMobile ? "translate-y-10 scale-100 opacity-0" : "scale-95 opacity-0",
          className
        )}
      >
        {showHandle && isMobile ? (
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30" />
        ) : null}
        {contextLabel && <p className="shrink-0 border-b px-5 py-2 text-sm font-semibold" data-dialog-context>{contextLabel}</p>}
        {(title || description) && (
          // Bureau : l'en-tête de Grok Bot (`ui-dialog-header`) : 12 / 16 px, sans
          // filet ; collé au corps quand il y en a un.
          <div className={cn("flex items-start justify-between gap-2", isMobile ? "px-5 py-4" : cn("px-4 pt-3", children ? "pb-0" : "pb-3"))}>
            <div className="min-w-0 flex-1">
              {title && (
                <h2
                  id={titleId}
                  className={cn(
                    "font-semibold",
                    isMobile ? "text-[17px] leading-[22px] text-[var(--openedbot-grouped-label)]" : "text-sm leading-5 font-medium text-foreground",
                  )}
                >
                  {title}
                </h2>
              )}
              {description && (
                <p
                  id={descriptionId}
                  className={cn(
                    "mt-0.5",
                    isMobile ? "text-[15px] leading-5 text-[var(--openedbot-grouped-caption)]" : "text-[13px] leading-[18px] text-muted-foreground",
                  )}
                >
                  {description}
                </p>
              )}
            </div>
            {showClose ? (
              isMobile ? (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={closeLabel}
                  data-inset-close=""
                  className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--openedbot-grouped-close)] text-[var(--openedbot-grouped-label)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-4" strokeWidth={2.25} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={closeLabel}
                  className="-mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--btn-veil-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
                >
                  <XIcon className="size-3.5" />
                </button>
              )
            ) : null}
          </div>
        )}

        {children && <div className={cn("scrollbar-subtle min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto text-foreground/80", isMobile ? "px-5 py-4 text-sm" : "px-4 pt-3 pb-4", bodyClassName)}>{children}</div>}

        {footer ? (
          <div
            data-mobile-action-footer={isMobile ? "" : undefined}
            className={cn(
              isMobile
                ? "flex min-h-11 shrink-0 flex-col gap-2 border-t-0 bg-[var(--openedbot-grouped-canvas)] px-4 pt-2 pb-[max(0.75rem,var(--openedbot-safe-bottom))]"
                : "flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-foreground/8 p-2.5",
              footerClassName,
            )}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
