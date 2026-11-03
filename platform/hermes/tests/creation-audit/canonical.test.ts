import { describe, expect, test } from "bun:test";
import { canonicalJsonString, CanonicalJsonError } from "../../src/creation-audit/canonical";

describe("JSON canonique (sous-ensemble RFC 8785 du contrat)", () => {
  // U+1F600 se code D83D DE00 en UTF-16 : il passe AVANT U+FFFF, contrairement
  // à l'ordre des points de code. C'est l'ordre RFC 8785, celui de Go (`lessUTF16`).
  test("clés triées par unités de code UTF-16, sans espace, champs undefined omis", () => {
    expect(canonicalJsonString({ b: 1, a: [true, null, "x"], "\u{1F600}": 2, "￿": 3, c: undefined }))
      .toBe('{"a":[true,null,"x"],"b":1,"\u{1F600}":2,"￿":3}');
  });

  test("échappement minimal : guillemet, antislash, contrôles courts, autres contrôles en \\u00xx minuscules", () => {
    expect(canonicalJsonString("a\"b\\c\b\f\n\r\t\x01\x1f<>& é"))
      .toBe('"a\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001f<>& é"');
  });

  test("les nombres non entiers sont refusés", () => {
    expect(() => canonicalJsonString({ x: 1.5 })).toThrow(CanonicalJsonError);
    expect(canonicalJsonString({ x: 0, y: -3 })).toBe('{"x":0,"y":-3}');
  });
});
