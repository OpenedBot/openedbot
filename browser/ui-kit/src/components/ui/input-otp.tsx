import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react"

import { cn } from "../../lib/utils"

type InputOtpProps = {
  /** Number of digit boxes. */
  length?: number
  value: string
  /**
   * The typed digits, empty boxes skipped: the code is complete only when its
   * length equals `length`.
   */
  onChange: (value: string) => void
  /** Fires once the last box is filled. */
  onComplete?: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
  "aria-label"?: string
  className?: string
  /** Skin of each digit box; the primitive only owns the behavior. */
  inputClassName?: string
}

const DIGITS_ONLY = /\D/g

/** One entry per box, `""` when empty: positions survive a cleared middle box. */
function otpSlots(value: string, length: number): string[] {
  const digits = value.replace(DIGITS_ONLY, "").slice(0, length)
  return Array.from({ length }, (_, index) => digits[index] ?? "")
}

/** Writes `digits` from `index` on, leaving every other box untouched. */
function otpWrite(slots: readonly string[], index: number, digits: string): string[] {
  const clean = digits.replace(DIGITS_ONLY, "")
  const next = [...slots]
  for (let offset = 0; offset < clean.length && index + offset < next.length; offset += 1) {
    next[index + offset] = clean[offset] ?? ""
  }
  return next
}

/** Backspace: clears the box if filled, else the previous one, which then takes focus. */
function otpErase(slots: readonly string[], index: number): { slots: string[]; focus: number } {
  const next = [...slots]
  if (next[index]) {
    next[index] = ""
    return { slots: next, focus: index }
  }
  const previous = Math.max(0, index - 1)
  next[previous] = ""
  return { slots: next, focus: previous }
}

/**
 * One box per digit, one value. Typing advances, Backspace steps back, arrows
 * move, paste and OS autofill (`one-time-code`) spread across the boxes.
 */
function InputOtp({
  length = 6,
  value,
  onChange,
  onComplete,
  disabled = false,
  autoFocus = false,
  "aria-label": ariaLabel = "One-time code",
  className,
  inputClassName,
}: InputOtpProps) {
  const groupId = useId()
  const inputsRef = useRef<Array<HTMLInputElement | null>>([])
  const external = value.replace(DIGITS_ONLY, "").slice(0, length)
  const [slots, setSlots] = useState(() => otpSlots(external, length))
  // The last value emitted: a different `value` comes from the parent (a
  // reset after a failed check) and replaces the boxes.
  const [emitted, setEmitted] = useState(external)
  if (external !== emitted || slots.length !== length) {
    setEmitted(external)
    setSlots(otpSlots(external, length))
  }

  const commit = (next: string[]) => {
    const joined = next.join("")
    setSlots(next)
    setEmitted(joined)
    onChange(joined)
    if (joined.length === length) onComplete?.(joined)
  }

  const focusBox = (index: number) => {
    const target = inputsRef.current[Math.max(0, Math.min(index, length - 1))]
    target?.focus()
    target?.select()
  }

  const writeFrom = (index: number, digits: string) => {
    const clean = digits.replace(DIGITS_ONLY, "")
    if (clean === "") return
    commit(otpWrite(slots, index, clean))
    focusBox(index + clean.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key === "Backspace") {
      event.preventDefault()
      const erased = otpErase(slots, index)
      commit(erased.slots)
      if (erased.focus !== index) focusBox(erased.focus)
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      focusBox(index - 1)
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      focusBox(index + 1)
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLInputElement>, index: number) => {
    event.preventDefault()
    writeFrom(index, event.clipboardData.getData("text"))
  }

  return (
    <div
      role="group"
      data-slot="input-otp"
      aria-label={ariaLabel}
      className={cn("flex items-center gap-2", className)}
    >
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(node) => {
            inputsRef.current[index] = node
          }}
          id={`${groupId}-${index}`}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={length}
          disabled={disabled}
          autoFocus={autoFocus && index === 0}
          aria-label={`${index + 1} / ${length}`}
          value={slots[index] ?? ""}
          onChange={(event) => writeFrom(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
          onPaste={(event) => onPaste(event, index)}
          onFocus={(event) => event.target.select()}
          className={cn(
            "h-11 min-w-0 flex-1 rounded-lg border border-input bg-transparent text-center font-mono text-base tabular-nums outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            inputClassName
          )}
        />
      ))}
    </div>
  )
}

export { InputOtp, otpErase, otpSlots, otpWrite, type InputOtpProps }
