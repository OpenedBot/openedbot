type UnionToIntersection<U> = (U extends unknown ? (part: U) => void : never) extends (part: infer I) => void ? I : never;

/**
 * Assembles the domain parts of `api` into one object. Descriptors are copied
 * (a getter keeps reading the assembled object), and a key defined twice is a
 * programming error, refused at load rather than silently overwritten.
 */
export function mergeApiParts<const Parts extends readonly object[]>(...parts: Parts): UnionToIntersection<Parts[number]> {
  const assembled = {};
  for (const part of parts) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
      if (Object.prototype.hasOwnProperty.call(assembled, key)) throw new Error(`lib/api: ${key} is defined twice.`);
      Object.defineProperty(assembled, key, descriptor);
    }
  }
  return assembled as UnionToIntersection<Parts[number]>;
}
