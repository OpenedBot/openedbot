/**
 * The onboarding surface's own primitives: Multica's, ported class for class.
 *
 * A separate subpath (`@openedbot/browser-ui-kit/components/onboarding`) rather than the main barrel: three
 * of these names (`Button`-shaped, `Input`-shaped, `Field`) already exist there
 * under the app's boardui scale, and re-exporting both sets would make every
 * import site guess which geometry it was getting. The `Ob` prefix says which
 * surface a control belongs to; the subpath keeps them out of everyone else's
 * autocomplete.
 */
export { ObButton, obButtonVariants } from "./button"
export { ObInput } from "./input"
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "./field"
export {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
  useStepItem,
  useStepper,
  type StepperItemProps,
  type StepperProps,
} from "./stepper"
export { DotSphere } from "./dot-sphere"
export { useScrollFade, type ScrollFadeAxis } from "../../hooks/use-scroll-fade"
