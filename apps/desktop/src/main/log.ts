import { recordDiagnostic } from "./diagnostics";

// Minimal logger. Call sites pass fixed messages and error.message only:
// tokens, codes, verifiers and callback URLs (their query carries secrets)
// must never be handed to these functions. Every line also goes to the
// diagnostics journal (diagnostics.ts), which redacts once more.
const PREFIX = "[openedbot-desktop]";

export const log = {
  info: (message: string): void => {
    console.log(PREFIX, message);
    recordDiagnostic("info", "main", message);
  },
  warn: (message: string): void => {
    console.warn(PREFIX, message);
    recordDiagnostic("warn", "main", message);
  },
  error: (message: string, error?: unknown): void => {
    const detail = error instanceof Error ? error.message : error === undefined ? "" : String(error);
    console.error(PREFIX, detail ? `${message}: ${detail}` : message);
    recordDiagnostic("error", "main", detail ? `${message}: ${detail}` : message);
  },
};
