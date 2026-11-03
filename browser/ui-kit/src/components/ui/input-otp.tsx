import {
  useId,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react"

import { cn } from "../../lib/utils"

type InputOtpProps = {
  /** Number of digit boxes. */
  length?: number
  value: string
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
  const code = value.replace(DIGITS_ONLY, "").slice(0, length)

  const commit = (next: string) => {
    const clean = next.replace(DIGITS_ONLY, "").slice(0, length)
    onChange(clean)
    if (clean.length === length) onComplete?.(clean)
  }

  const focusBox = (index: number) => {
    const target = inputsRef.current[Math.max(0, Math.min(index, length - 1))]
    target?.focus()
    target?.select()
  }

  const writeFrom = (index: number, digits: string) => {
    const clean = digits.replace(DIGITS_ONLY, "")
    if (clean === "") return
    const chars = code.padEnd(length, " ").split("")
    for (let offset = 0; offset < clean.length && index + offset < length; offset += 1) {
      chars[index + offset] = clean[offset] ?? ""
    }
    commit(chars.join("").trimEnd())
    focusBox(index + clean.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key === "Backspace") {
      event.preventDefault()
      const chars = code.padEnd(length, " ").split("")
      if (code[index]) {
        chars[index] = " "
        commit(chars.join("").trimEnd())
        return
      }
      chars[Math.max(0, index - 1)] = " "
      commit(chars.join("").trimEnd())
      focusBox(index - 1)
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
          value={code[index] ?? ""}
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

export { InputOtp, type InputOtpProps }
