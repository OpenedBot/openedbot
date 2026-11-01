/** Defense in depth: connector diagnostics must never carry credentials. */
export function sanitizeDiagnosticText(text: string, maxBytes: number): string {
  const sanitized = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[redacted header]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(password|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]");
  let out = "";
  let bytes = 0;
  for (const character of sanitized) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    out += character;
    bytes += size;
  }
  return out;
}
