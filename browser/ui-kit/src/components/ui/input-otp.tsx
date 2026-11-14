import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react"

import { cn } from "../../lib/utils"

/**
 * - `verifying`: the code is out, the field is locked and the digits dim;
 * - `error`: the boxes turn red and the row shakes once;
 * - `success`: the boxes turn green, the cursor and the focus ring leave.
 */
type InputOtpStatus = "idle" | "verifying" | "error" | "success"

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
  status?: InputOtpStatus
  /** Under the boxes, announced politely (assertively on `error`). */
  message?: ReactNode
  disabled?: boolean
  autoFocus?: boolean
  "aria-label"?: string
  className?: string
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

/** The box the cursor goes to: the first empty one, or the last when all are filled. */
function otpFirstEmpty(slots: readonly string[]): number {
  const index = slots.findIndex((digit) => !digit)
  return index === -1 ? Math.max(0, slots.length - 1) : index
}

/** The row splits in two halves (3 + 3 for six digits), easier to read back. */
function otpGroupStart(length: number): number {
  return Math.ceil(length / 2)
}

const SHAKE: Keyframe[] = [
  { transform: "translateX(0)" },
  { transform: "translateX(-5px)" },
  { transform: "translateX(5px)" },
  { transform: "translateX(-3px)" },
  { transform: "translateX(3px)" },
  { transform: "translateX(-1px)" },
  { transform: "translateX(0)" },
]

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
}

/**
 * One native field drawn as boxes. The field holds the whole code, so OS
 * autofill (`one-time-code`), a soft keyboard and paste read and write it in
 * one place; the boxes only draw it. One focus ring slides from box to box.
 * Typing advances, Backspace steps back, arrows, Home and End move.
 */
function InputOtp({
  length = 6,
  value,
  onChange,
  onComplete,
  status = "idle",
  message,
  disabled = false,
  autoFocus = false,
  "aria-label": ariaLabel = "One-time code",
  className,
}: InputOtpProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const messageId = `${useId()}-message`
  const external = value.replace(DIGITS_ONLY, "").slice(0, length)
  const [slots, setSlots] = useState(() => otpSlots(external, length))
  const [active, setActive] = useState(() => otpFirstEmpty(otpSlots(external, length)))
  const [focused, setFocused] = useState(false)
  // The last value emitted: a different `value` comes from the parent (a
  // reset after a failed check) and replaces the boxes.
  const [emitted, setEmitted] = useState(external)
  if (external !== emitted || slots.length !== length) {
    const next = otpSlots(external, length)
    setEmitted(external)
    setSlots(next)
    setActive(otpFirstEmpty(next))
  }

  const locked = disabled || status === "verifying" || status === "success"
  const joined = slots.join("")
  const groupStart = otpGroupStart(length)

  const [previousStatus, setPreviousStatus] = useState(status)
  const [shakes, setShakes] = useState(0)
  if (status !== previousStatus) {
    setPreviousStatus(status)
    if (status === "error") setShakes((count) => count + 1)
  }
  useEffect(() => {
    if (shakes === 0 || reducedMotion()) return
    const animation = rowRef.current?.animate?.(SHAKE, { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" })
    return () => animation?.cancel()
  }, [shakes])

  // A field unlocked again (a failed check) takes the keyboard back.
  useEffect(() => {
    if (!locked && autoFocus) inputRef.current?.focus({ preventScroll: true })
  }, [locked, autoFocus])

  const commit = (next: string[], nextActive: number) => {
    const code = next.join("")
    setSlots(next)
    setActive(Math.max(0, Math.min(nextActive, length - 1)))
    if (code === joined) return
    setEmitted(code)
    onChange(code)
    if (code.length === length) onComplete?.(code)
  }

  const insert = (digits: string, from: number) => {
    const clean = digits.replace(DIGITS_ONLY, "")
    if (clean === "") return
    commit(otpWrite(slots, from, clean), from + clean.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (locked) {
      if (event.key !== "Tab") event.preventDefault()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (/^\d$/.test(event.key)) {
      event.preventDefault()
      insert(event.key, active)
    } else if (event.key === "Backspace") {
      event.preventDefault()
      const erased = otpErase(slots, active)
      commit(erased.slots, erased.focus)
    } else if (event.key === "Delete") {
      event.preventDefault()
      const next = [...slots]
      next[active] = ""
      commit(next, active)
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      setActive((index) => Math.max(0, index - 1))
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      setActive((index) => Math.min(length - 1, index + 1))
    } else if (event.key === "Home") {
      event.preventDefault()
      setActive(0)
    } else if (event.key === "End") {
      event.preventDefault()
      setActive(length - 1)
    }
  }

  // What the keys above do not catch: autofill, a suggestion, a soft keyboard
  // that sends no key name. The field then holds the code it wants.
  const onFieldChange = (raw: string) => {
    if (locked) return
    const digits = raw.replace(DIGITS_ONLY, "").slice(0, length)
    if (digits === joined) return
    const next = otpSlots(digits, length)
    commit(next, otpFirstEmpty(next))
  }

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault()
    if (locked) return
    const digits = event.clipboardData.getData("text").replace(DIGITS_ONLY, "")
    // A whole code replaces the boxes; a part lands from the cursor on.
    insert(digits, digits.length >= length ? 0 : active)
  }

  // The field covers the boxes: a press picks the nearest box by position.
  const onPointerDown = (event: PointerEvent<HTMLInputElement>) => {
    if (locked) return
    event.preventDefault()
    const boxes = rowRef.current?.querySelectorAll<HTMLElement>("[data-otp-index]")
    let nearest = 0
    let distance = Number.POSITIVE_INFINITY
    boxes?.forEach((box, index) => {
      const bounds = box.getBoundingClientRect()
      const gap = Math.abs(event.clientX - (bounds.left + bounds.width / 2))
      if (gap < distance) {
        distance = gap
        nearest = index
      }
    })
    setActive(nearest)
    inputRef.current?.focus({ preventScroll: true })
  }

  const showCursor = focused && !locked
  const rowStyle = {
    "--otp-active": active,
    "--otp-group-shift": active >= groupStart ? "var(--otp-group-gap)" : "0px",
  } as CSSProperties

  return (
    <div data-slot="input-otp" data-status={status} className={cn("otp", className)}>
      <div className="otp-field">
        <input
          ref={inputRef}
          className="otp-native"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCorrect="off"
          spellCheck={false}
          maxLength={length}
          disabled={disabled}
          readOnly={status === "verifying" || status === "success"}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          aria-invalid={status === "error" ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          value={joined}
          onChange={(event) => onFieldChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onPointerDown={onPointerDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <div ref={rowRef} className="otp-row" style={rowStyle} aria-hidden="true">
          <span className="otp-ring" data-visible={showCursor || undefined} />
          {slots.map((digit, index) => (
            <span
              key={index}
              className="otp-box"
              data-otp-index={index}
              data-filled={digit ? true : undefined}
              data-group-start={index === groupStart || undefined}
            >
              {showCursor && index === active ? (
                <span className="otp-caret" data-trailing={digit ? true : undefined} />
              ) : null}
              {digit ? (
                // A new key per digit replays the entrance when a box is retyped.
                <span key={`${index}-${digit}`} className="otp-digit">{digit}</span>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <p
        id={messageId}
        className="otp-message"
        role={status === "error" ? "alert" : "status"}
        aria-live={status === "error" ? "assertive" : "polite"}
      >
        {message ? (
          <>
            {status === "success" ? (
              <svg className="otp-check" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 13l4 4L19 7" />
              </svg>
            ) : null}
            {message}
          </>
        ) : null}
      </p>
    </div>
  )
}

export { InputOtp, otpErase, otpFirstEmpty, otpGroupStart, otpSlots, otpWrite, type InputOtpProps, type InputOtpStatus }
