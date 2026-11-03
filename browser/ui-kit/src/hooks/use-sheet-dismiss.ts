import * as React from "react"

/**
 * Le geste qui referme une feuille : le doigt vers le bas, comme sur iOS.
 *
 * La poignée existait déjà en haut de chaque feuille : elle ne servait à rien.
 * Une barre de 36 px qui ressemble à une prise et qui ne se prend pas est le
 * genre de détail qui trahit une page web : l'utilisateur tire, rien ne bouge,
 * et il finit par chercher la croix. Le geste est donc réel, et il suit le
 * doigt pendant toute sa course, pas seulement au relâchement.
 *
 * Les seuils sont ceux du tiroir (`mobile-navigation.ts`) et de la pile
 * in-sheet (`sheet-stack.tsx`), pour qu'un même mouvement décide pareil quel
 * que soit l'axe.
 */

/** Sous ce déplacement, le doigt n'a pas encore choisi entre scroll et geste. */
export const SHEET_DRAG_SLOP = 8
/** Fraction de la hauteur qui referme au relâchement (sans lancer). */
export const SHEET_DISMISS_RATIO = 0.25
/** Vitesse (px/ms) qui emporte la décision quand la course est incomplète. */
export const SHEET_FLING_VELOCITY = 0.35
const SLIDE = "300ms cubic-bezier(0.32, 0.72, 0, 1)"

/**
 * Le geste est-il un balayage vers le bas ?
 *
 * Vers le BAS et plus vertical qu'horizontal : la pile in-sheet
 * (`MobileSheetStack`) écoute le même pointeur pour son pop vers la droite, et
 * deux gestes ne peuvent pas capturer le même doigt. L'axe départage.
 */
export function sheetDragCaptures(input: { dx: number; dy: number }): boolean {
  return input.dy > SHEET_DRAG_SLOP && input.dy > Math.abs(input.dx)
}

/** La feuille se referme-t-elle au relâchement ? */
export function decideSheetDismiss(input: {
  offset: number
  height: number
  velocity: number
}): boolean {
  if (input.velocity > SHEET_FLING_VELOCITY) return true
  // Un jitter de lift vers le haut ne doit pas annuler une course déjà faite,
  // mais un vrai retour en arrière, si.
  if (input.velocity < -SHEET_FLING_VELOCITY && input.offset <= input.height / 2) {
    return false
  }
  return input.offset > input.height * SHEET_DISMISS_RATIO
}

/**
 * Une rubrique poussée DANS la feuille (`MobileSheetStack`).
 *
 * Deux niveaux plus bas, le doigt vers le bas ne peut pas vouloir dire « jette
 * tout » : on est entré dans une option, et la sortie qu'on cherche est le
 * « ‹ Retour » du panneau, pas la fermeture de la feuille entière. Sans cette
 * garde, tirer vers le bas depuis une rubrique refermait la feuille ET la pile
 * qu'elle portait : le geste le plus naturel de l'écran détruisait le plus de
 * contexte.
 *
 * Le pop horizontal reste, lui, disponible : les deux gestes ne se disputent
 * pas le même axe.
 */
const PUSHED_PANEL_SELECTOR = "[data-sheet-pushed]";

function insidePushedPanel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(PUSHED_PANEL_SELECTOR) !== null
}

/**
 * Le défileur qui porte le point de départ, s'il y en a un.
 *
 * Un geste vers le bas qui commence dans un corps DÉJÀ défilé est un scroll,
 * pas une fermeture : la feuille ne bouge que quand la liste est en haut.
 * C'est la règle d'iOS, et sans elle on referme la feuille en voulant
 * remonter une liste.
 */
function scrollerAt(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  let node = target instanceof HTMLElement ? target : null
  while (node !== null && node !== root.parentElement) {
    if (node.scrollHeight > node.clientHeight) {
      const overflow = getComputedStyle(node).overflowY
      if (overflow === "auto" || overflow === "scroll") return node
    }
    node = node.parentElement
  }
  return null
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

type Drag = {
  pointerId: number
  startX: number
  startY: number
  lastY: number
  lastT: number
  velocity: number
  captured: boolean
  aborted: boolean
}

export type SheetDismissDrag = {
  /** `translateY` en cours, ou `null` quand la feuille est au repos. */
  offset: number | null
  /** 0 au repos, 1 quand la feuille a fini sa course vers le bas. */
  progress: number
  /** Le doigt tient la feuille : pas de transition, elle suit. */
  dragging: boolean
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
    onTransitionEnd: (event: React.TransitionEvent<HTMLElement>) => void
  }
}

/** Au-delà, le navigateur n'émettra plus de clic pour ce relâchement. */
const CLICK_GRACE_MS = 400

/**
 * `enabled` est faux hors mobile et sur les feuilles qui ne se referment pas
 * au geste (une confirmation destructive : on choisit, on ne balaye pas).
 */
export function useSheetDismissDrag<T extends HTMLElement>({
  enabled,
  onClose,
  sheetRef,
}: {
  enabled: boolean
  onClose: () => void
  sheetRef: React.RefObject<T | null>
}): SheetDismissDrag {
  const drag = React.useRef<Drag | null>(null)
  const swallowClick = React.useRef<(() => void) | null>(null)
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose
  const [offset, setOffset] = React.useState<number | null>(null)
  const [settling, setSettling] = React.useState<"close" | "back" | null>(null)
  const [height, setHeight] = React.useState(0)

  React.useEffect(() => {
    if (!enabled) return
    const sheet = sheetRef.current
    if (!sheet) return
    const sync = () => setHeight(sheet.getBoundingClientRect().height)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(sheet)
    return () => observer.disconnect()
  }, [enabled, sheetRef])

  React.useEffect(() => {
    if (!enabled) return
    drag.current = null
    setOffset(null)
    setSettling(null)
  }, [enabled])

  /**
   * Avaler le clic qui suit un balayage : sur le DOCUMENT, pas sur la feuille.
   *
   * Le navigateur émet encore un `click` après le relâchement, et la feuille
   * qu'on vient de pousser hors de l'écran n'est plus sous le doigt : le clic
   * tombait donc sur ce qui restait dessous. Quand la feuille était empilée
   * sur une autre, il atterrissait sur le VOILE de celle du dessous, dont le
   * `onClick` ferme : un seul geste refermait les deux, et avec elles la pile
   * de rubriques qu'elles portaient. Un écouteur posé sur la feuille ne
   * pouvait rien y faire : le clic ne la traverse pas, il la manque.
   */
  const armClickGuard = React.useCallback(() => {
    swallowClick.current?.()
    const swallow = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener("click", swallow, { capture: true, once: true })
    // Aucun clic ne vient toujours (relâchement hors d'une cible cliquable) :
    // le garde ne doit pas survivre pour manger le geste suivant.
    const timer = window.setTimeout(() => {
      document.removeEventListener("click", swallow, true)
      swallowClick.current = null
    }, CLICK_GRACE_MS)
    swallowClick.current = () => {
      window.clearTimeout(timer)
      document.removeEventListener("click", swallow, true)
      swallowClick.current = null
    }
  }, [])

  React.useEffect(() => () => swallowClick.current?.(), [])

  const finish = React.useCallback(() => {
    // L'offset N'EST PAS remis à zéro : la feuille est sortie de l'écran, et
    // l'y ramener le temps du fondu de sortie se verrait.
    setSettling(null)
    onCloseRef.current()
  }, [])

  // Filet : si `transitionend` ne vient pas (feuille démontée, transition
  // coupée), la décision ne doit pas rester en l'air.
  React.useEffect(() => {
    if (settling === null) return
    const timer = window.setTimeout(() => {
      if (settling === "close") finish()
      else {
        setOffset(null)
        setSettling(null)
      }
    }, 360)
    return () => window.clearTimeout(timer)
  }, [settling, finish])

  /*
    Safari prend le geste vertical pour un rebond de page (« rubber band »)
    et le joue par-dessus notre translation. Listener natif NON passif, armé
    seulement pendant la capture, jamais avant, sinon un scroll de liste
    dans la feuille serait confisqué.
  */
  React.useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet || !enabled) return
    const onMove = (event: TouchEvent) => {
      if (drag.current?.captured && event.cancelable) event.preventDefault()
    }
    sheet.addEventListener("touchmove", onMove, { passive: false })
    return () => sheet.removeEventListener("touchmove", onMove)
  }, [enabled, sheetRef])

  /**
   * Le geste se suit sur la FENÊTRE, pas sur la feuille.
   *
   * `setPointerCapture` ne tient pas : mesuré, le `pointerup` d'un balayage
   * arrivait sur la feuille du DESSOUS, pas sur celle qu'on tirait. La feuille
   * descend sous le doigt, le doigt sort de sa boîte, et les `pointermove`
   * cessent d'y remonter : le voile est son parent, pas son enfant, donc rien
   * ne bulle. Le geste ne se terminait alors jamais, et le clic de fin
   * atterrissait sur ce qu'il y avait dessous : dans une feuille empilée, la
   * ligne de profil de celle du dessous, qui NAVIGUE. Un balayage refermait
   * ainsi tout l'écran.
   *
   * Des écouteurs sur `window` le temps du geste suivent le doigt où qu'il
   * aille, et se retirent au relâchement.
   */
  const release = React.useRef<(() => void) | null>(null)

  React.useEffect(() => () => release.current?.(), [])

  const onPointerMove = (event: PointerEvent) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId || current.aborted) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.captured) {
      // Vers le haut, ou plus horizontal que vertical : ce doigt ne nous
      // appartient pas : il scrolle, ou il poppe la pile in-sheet.
      if (dy < -SHEET_DRAG_SLOP || (Math.abs(dx) > SHEET_DRAG_SLOP && Math.abs(dx) >= Math.abs(dy))) {
        current.aborted = true
        return
      }
      if (!sheetDragCaptures({ dx, dy })) return
      current.captured = true
    }
    const dt = Math.max(1, event.timeStamp - current.lastT)
    current.velocity = (event.clientY - current.lastY) / dt
    current.lastY = event.clientY
    current.lastT = event.timeStamp
    if (prefersReducedMotion()) return
    setOffset(Math.max(0, dy))
  }

  const onPointerUp = (event: PointerEvent) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    release.current?.()
    if (!current.captured) {
      setOffset(null)
      return
    }
    // Le geste a bougé la feuille : le clic qui suit n'est pas un tap.
    armClickGuard()
    const dy = Math.max(0, event.clientY - current.startY)
    const reach = height || sheetRef.current?.getBoundingClientRect().height || 1
    const dismiss = decideSheetDismiss({ offset: dy, height: reach, velocity: current.velocity })
    if (prefersReducedMotion()) {
      if (dismiss) finish()
      else setOffset(null)
      return
    }
    if (dismiss) {
      setSettling("close")
      setOffset(reach)
      return
    }
    setSettling("back")
    setOffset(0)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || settling !== null) return
    const sheet = sheetRef.current
    if (!sheet) return
    /*
      Le geste doit être NÉ dans cette feuille-ci.

      React fait remonter les événements d'un portail par son arbre à LUI, pas
      par le DOM : une feuille ouverte depuis une autre est, côté React, une
      enfant de la première. Son `pointerdown` arrivait donc aussi au
      `onPointerDown` de la feuille du dessous, qui armait son propre geste et
      se refermait avec : un seul balayage emportait les deux, et la pile de
      rubriques avec elles. Le DOM, lui, ne ment pas : deux portails frères.
    */
    if (!(event.target instanceof Node) || !sheet.contains(event.target)) return
    if (insidePushedPanel(event.target)) return
    const scroller = scrollerAt(event.target, sheet)
    // Une liste déjà descendue se remonte : la feuille ne suit pas le doigt.
    if (scroller !== null && scroller.scrollTop > 0) return
    release.current?.()
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      lastT: event.timeStamp,
      velocity: 0,
      captured: false,
      aborted: false,
    }
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerUp)
    release.current = () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerUp)
      release.current = null
    }
  }

  return {
    offset,
    progress: offset === null || height === 0 ? 0 : Math.min(1, offset / height),
    dragging: offset !== null && settling === null,
    handlers: {
      onPointerDown,
      // La décision se solde à la FIN de la course, pas sur un minuteur : le
      // filet plus haut n'existe que pour la transition qui n'arrive jamais.
      onTransitionEnd: (event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "transform") return
        if (settling === "close") finish()
        else if (settling === "back") {
          setOffset(null)
          setSettling(null)
        }
      },
    },
  }
}

/** La transition posée sur la feuille quand le doigt l'a lâchée. */
export const SHEET_SETTLE_TRANSITION = `transform ${SLIDE}`
