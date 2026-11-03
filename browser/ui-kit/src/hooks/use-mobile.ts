import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px), (pointer: coarse) and (max-height: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Un téléphone reste un téléphone en paysage. Une coupure fondée uniquement
 * sur la largeur faisait passer un iPhone 15 Pro Max (932 × 430) au layout
 * desktop. Le critère de hauteur ne s'applique qu'aux pointeurs tactiles pour
 * ne pas transformer une fenêtre desktop large et basse en coque mobile.
 */
export function isMobileViewport(width: number, height: number, coarsePointer: boolean): boolean {
  return width < MOBILE_BREAKPOINT || (coarsePointer && height < MOBILE_BREAKPOINT)
}

function readMobileViewport(): boolean {
  return isMobileViewport(window.innerWidth, window.innerHeight, window.matchMedia("(pointer: coarse)").matches)
}

/**
 * Lu de façon synchrone au premier rendu : un `undefined` initial montait
 * la coque bureau une frame avant de la remplacer par la coque mobile,
 * deux arbres, deux séries de requêtes, et un flash de barre latérale.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(() =>
    typeof window === "undefined" ? undefined : readMobileViewport(),
  )

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY)
    const onChange = () => {
      setIsMobile(readMobileViewport())
    }
    mql.addEventListener("change", onChange)
    setIsMobile(readMobileViewport())
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

/**
 * Un pointeur grossier: un doigt.
 *
 * Distinct de `useIsMobile()` : une fenêtre bureau étroite passe en coque
 * mobile mais garde sa souris, et doit garder ses affordances de survol. Ce
 * qui dépend du DOIGT (cible de 44 pt, appui long au lieu du survol) se décide
 * ici. En happy-dom, `matchMedia` répond `false` : les tests restent sur la
 * branche pointeur fin.
 */
export function useCoarsePointer() {
  const [coarse, setCoarse] = React.useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia("(pointer: coarse)").matches,
  )

  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const mql = window.matchMedia("(pointer: coarse)")
    const onChange = () => setCoarse(mql.matches)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return coarse
}
