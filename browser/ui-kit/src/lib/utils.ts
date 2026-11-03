import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * The BoardUI type scale (`text-body-medium`, `text-caption-1-bold`, …, declared
 * in styles/app.css) bundles font-size + line-height + weight.
 *
 * tailwind-merge doesn't know these names, so it files them under `text-color`
 * and lets any `text-foreground` that follows drop them: the element silently
 * falls back to the inherited 16px. Registering them as font-size keeps a size
 * and a colour from ever cancelling each other out.
 */
const TYPE_SCALE = [
  "display-1",
  "display-2",
  "display-3",
  "display-4",
  "title-1",
  "title-2",
  "title-3",
  "headline",
  "body",
  "body-2",
  "caption-1",
  "caption-2",
].flatMap((family) =>
  ["regular", "medium", "semibold", "bold"].map((weight) => `${family}-${weight}`)
)

/**
 * Multica's scale (styles/app.css), used by the ported onboarding screens.
 * Registered for the same reason as the BoardUI one above, and more urgently:
 * these names carry no weight suffix, so `text-body` looks exactly like a
 * colour utility to tailwind-merge, and `cn("text-body", "text-muted-foreground")`
 * would silently ship a 16px paragraph.
 */
const ONBOARDING_TYPE_SCALE = [
  "micro",
  "caption",
  "label",
  "body",
  "body-lg",
  "title-sm",
  "title",
  "title-lg",
]

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [...TYPE_SCALE, ...ONBOARDING_TYPE_SCALE].map(
        (name) => `text-${name}`
      ),
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Group a number's integer part with thousands separators (e.g. 1234567 → "1,234,567"). */
export const commas = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
