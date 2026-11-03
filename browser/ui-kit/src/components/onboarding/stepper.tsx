"use client"

import type { HTMLAttributes, ReactElement } from "react"
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react"

import { cn } from "../../lib/utils"

/**
 * Stepper primitives, ported from Multica (ReUI's stepper block).
 *
 * One deliberate omission: `StepperTrigger`. Upstream it is a base-ui
 * `useRender` button carrying `role="tab"` + `aria-controls` on a panel id,
 * correct for a stepper that renders its own panels, wrong for the onboarding
 * rail, where the panel is a routed step and those ids would dangle. The rail
 * marks position with `aria-current="step"` and renders its own button for the
 * "go back to a completed step" affordance, so nothing here uses the trigger,
 * and dropping it drops base-ui with it. The roving-focus machinery that only
 * served triggers goes with it for the same reason.
 */

type StepperOrientation = "horizontal" | "vertical"
type StepState = "active" | "completed" | "inactive" | "loading"
type StepIndicators = {
  active?: React.ReactNode
  completed?: React.ReactNode
  inactive?: React.ReactNode
  loading?: React.ReactNode
}

interface StepperContextValue {
  activeStep: number
  setActiveStep: (step: number) => void
  stepsCount: number
  orientation: StepperOrientation
  indicators: StepIndicators
}

interface StepItemContextValue {
  step: number
  state: StepState
  isDisabled: boolean
  isLoading: boolean
}

const StepperContext = createContext<StepperContextValue | undefined>(undefined)
const StepItemContext = createContext<StepItemContextValue | undefined>(
  undefined
)

function useStepper() {
  const ctx = useContext(StepperContext)
  if (!ctx) throw new Error("useStepper must be used within a Stepper")
  return ctx
}

function useStepItem() {
  const ctx = useContext(StepItemContext)
  if (!ctx) throw new Error("useStepItem must be used within a StepperItem")
  return ctx
}

interface StepperProps extends HTMLAttributes<HTMLDivElement> {
  defaultValue?: number
  value?: number
  onValueChange?: (value: number) => void
  orientation?: StepperOrientation
  indicators?: StepIndicators
}

function Stepper({
  defaultValue = 1,
  value,
  onValueChange,
  orientation = "horizontal",
  className,
  children,
  indicators = {},
  ...props
}: StepperProps) {
  const [activeStep, setActiveStep] = useState(defaultValue)

  const handleSetActiveStep = useCallback(
    (step: number) => {
      if (value === undefined) {
        setActiveStep(step)
      }
      onValueChange?.(step)
    },
    [value, onValueChange]
  )

  const currentStep = value ?? activeStep

  const contextValue = useMemo<StepperContextValue>(
    () => ({
      activeStep: currentStep,
      setActiveStep: handleSetActiveStep,
      stepsCount: Children.toArray(children).filter(
        (child): child is ReactElement =>
          isValidElement(child) &&
          (child.type as { displayName?: string }).displayName === "StepperItem"
      ).length,
      orientation,
      indicators,
    }),
    [currentStep, handleSetActiveStep, children, orientation, indicators]
  )

  return (
    <StepperContext.Provider value={contextValue}>
      <div
        role="tablist"
        aria-orientation={orientation}
        data-slot="stepper"
        className={cn("w-full", className)}
        data-orientation={orientation}
        {...props}
      >
        {children}
      </div>
    </StepperContext.Provider>
  )
}

interface StepperItemProps extends React.HTMLAttributes<HTMLDivElement> {
  step: number
  completed?: boolean
  disabled?: boolean
  loading?: boolean
}

function StepperItem({
  step,
  completed = false,
  disabled = false,
  loading = false,
  className,
  children,
  ...props
}: StepperItemProps) {
  const { activeStep } = useStepper()

  const state: StepState =
    completed || step < activeStep
      ? "completed"
      : activeStep === step
        ? "active"
        : "inactive"

  const isLoading = loading && step === activeStep

  return (
    <StepItemContext.Provider
      value={{ step, state, isDisabled: disabled, isLoading }}
    >
      <div
        data-slot="stepper-item"
        className={cn(
          "group/step flex items-center justify-center not-last:flex-1 group-data-[orientation=horizontal]/stepper-nav:flex-row group-data-[orientation=vertical]/stepper-nav:flex-col",
          className
        )}
        data-state={state}
        {...(isLoading ? { "data-loading": true } : {})}
        {...props}
      >
        {children}
      </div>
    </StepItemContext.Provider>
  )
}

function StepperIndicator({
  children,
  className,
}: React.ComponentProps<"div">) {
  const { state, isLoading } = useStepItem()
  const { indicators } = useStepper()

  return (
    <div
      data-slot="stepper-indicator"
      data-state={state}
      className={cn(
        "border-background bg-accent text-accent-foreground data-[state=completed]:bg-primary data-[state=completed]:text-primary-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground relative flex size-6 shrink-0 items-center justify-center overflow-hidden",
        "rounded-full text-caption",
        className
      )}
    >
      <div className="absolute">
        {indicators &&
        ((isLoading && indicators.loading) ||
          (state === "completed" && indicators.completed) ||
          (state === "active" && indicators.active) ||
          (state === "inactive" && indicators.inactive))
          ? (isLoading && indicators.loading) ||
            (state === "completed" && indicators.completed) ||
            (state === "active" && indicators.active) ||
            (state === "inactive" && indicators.inactive)
          : children}
      </div>
    </div>
  )
}

function StepperSeparator({ className }: React.ComponentProps<"div">) {
  const { state } = useStepItem()

  return (
    <div
      data-slot="stepper-separator"
      data-state={state}
      className={cn(
        "bg-muted rounded-sm m-0.5 group-data-[orientation=horizontal]/stepper-nav:h-0.5 group-data-[orientation=horizontal]/stepper-nav:flex-1 group-data-[orientation=vertical]/stepper-nav:h-12 group-data-[orientation=vertical]/stepper-nav:w-0.5",
        className
      )}
    />
  )
}

function StepperTitle({ children, className }: React.ComponentProps<"h3">) {
  const { state } = useStepItem()

  return (
    <h3
      data-slot="stepper-title"
      data-state={state}
      className={cn("text-label font-medium", className)}
    >
      {children}
    </h3>
  )
}

function StepperDescription({
  children,
  className,
}: React.ComponentProps<"div">) {
  const { state } = useStepItem()

  return (
    <div
      data-slot="stepper-description"
      data-state={state}
      className={cn("text-muted-foreground text-caption", className)}
    >
      {children}
    </div>
  )
}

function StepperNav({ children, className }: React.ComponentProps<"nav">) {
  const { activeStep, orientation } = useStepper()

  return (
    <nav
      data-slot="stepper-nav"
      data-state={activeStep}
      data-orientation={orientation}
      className={cn(
        "group/stepper-nav inline-flex data-[orientation=horizontal]:w-full data-[orientation=horizontal]:flex-row data-[orientation=vertical]:flex-col",
        className
      )}
    >
      {children}
    </nav>
  )
}

export {
  useStepper,
  useStepItem,
  Stepper,
  StepperItem,
  StepperIndicator,
  StepperSeparator,
  StepperTitle,
  StepperDescription,
  StepperNav,
  type StepperProps,
  type StepperItemProps,
}
