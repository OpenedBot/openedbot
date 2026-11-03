/**
 * JSON canonique de l'audit de création, identique octet pour octet à
 * `canonicalJSON` de `edge-setup` (`internal/connector/audit_format.go`) :
 * clés triées par unités de code UTF-16, aucun espace, échappement minimal
 * (`\" \\ \b \f \n \r \t`, autres contrôles en `\u00xx` minuscules, ni HTML ni
 * U+2028/U+2029), entiers seuls. La chaîne de hachage et l'en-tête clair du
 * fichier sont calculés sur cette forme : un octet de différence casse la
 * vérification, jamais en silence.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

const encoder = new TextEncoder();

/** Encode `value` sous sa forme canonique, en octets UTF-8. */
export function canonicalJson(value: unknown): Uint8Array {
  return encoder.encode(canonicalJsonString(value));
}

/** La même forme canonique, en chaîne (pratique pour les tests et les traces). */
export function canonicalJsonString(value: unknown): string {
  const parts: string[] = [];
  writeCanonical(parts, value);
  return parts.join("");
}

function writeCanonical(out: string[], value: unknown): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`canonical JSON allows safe integers only, got ${value}`);
      out.push(String(value));
      return;
    case "bigint":
      out.push(value.toString(10));
      return;
    case "string":
      out.push(canonicalString(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        value.forEach((item, index) => {
          if (index > 0) out.push(",");
          writeCanonical(out, item);
        });
        out.push("]");
        return;
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
      // `<` sur deux chaînes JS compare leurs unités de code UTF-16 : c'est
      // exactement l'ordre RFC 8785 que le côté Go reproduit avec `lessUTF16`.
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      out.push("{");
      entries.forEach(([key, entry], index) => {
        if (index > 0) out.push(",");
        out.push(canonicalString(key), ":");
        writeCanonical(out, entry);
      });
      out.push("}");
      return;
    }
    default:
      throw new CanonicalJsonError(`canonical JSON cannot encode ${typeof value}`);
  }
}

function canonicalString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    switch (char) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default:
        if (code < 0x20) out += `\\u00${code.toString(16).padStart(2, "0")}`;
        else out += char;
    }
  }
  return `${out}"`;
}
