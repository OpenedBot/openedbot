import { useState } from "react";
import { BUTTON } from "./primitives";

/**
 * Copy a value: third occurrence of the pattern, hence the extraction.
 *
 * Both details inherited from the copies (Devices, Models) are kept:
 * `navigator.clipboard?` (absent outside a secure context) and the `.catch` which
 * never says « Copié » when permission has been refused.
 */
export function CopyButton({
  value,
  copyLabel,
  copiedLabel,
  className = BUTTON.secondary,
  copiedClassName,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
  /** The button's appearance once copied: green « success » when the screen wants it. */
  copiedClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={copied ? (copiedClassName ?? className) : className}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}
