// Serves the static assets only to the networks listed in the ALLOWED_NETS
// secret (comma-separated IPv4 addresses, IPv4 CIDRs, IPv6 addresses or IPv6
// CIDRs). The list lives in the Worker secret, never in the repository. A
// missing or empty list refuses every request: the gate fails closed.

const FORBIDDEN = () =>
  new Response("Forbidden\n", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

function parseV4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function parseV6(text) {
  if (!/^[0-9a-f:.]+$/i.test(text) || text.split("::").length > 2) return null;
  // An embedded IPv4 tail (::ffff:192.0.2.1) becomes its two last groups.
  const lastColon = text.lastIndexOf(":");
  if (lastColon < 0) return null;
  if (text.includes(".")) {
    const v4 = parseV4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  const group = (s) => (s === "" ? [] : s.split(":"));
  const left = group(halves[0]);
  const right = halves.length === 2 ? group(halves[1]) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function parseAddress(text) {
  const v4 = parseV4(text);
  if (v4 !== null) return { family: 4, bits: 32, value: v4 };
  const v6 = parseV6(text);
  if (v6 !== null) return { family: 6, bits: 128, value: v6 };
  return null;
}

export function parseNets(list) {
  const nets = [];
  for (const raw of String(list ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addr, prefixText] = entry.split("/");
    const parsed = parseAddress(addr);
    if (!parsed) throw new Error(`ALLOWED_NETS: invalid address ${entry}`);
    const prefix = prefixText === undefined ? parsed.bits : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits || (prefixText !== undefined && !/^\d+$/.test(prefixText))) {
      throw new Error(`ALLOWED_NETS: invalid prefix ${entry}`);
    }
    const shift = BigInt(parsed.bits - prefix);
    nets.push({ family: parsed.family, shift, base: parsed.value >> shift });
  }
  return nets;
}

export function allowed(ip, nets) {
  const parsed = parseAddress(String(ip ?? "").trim());
  if (!parsed) return false;
  return nets.some((net) => net.family === parsed.family && parsed.value >> net.shift === net.base);
}

export default {
  async fetch(request, env) {
    let nets;
    try {
      nets = parseNets(env.ALLOWED_NETS);
    } catch {
      return FORBIDDEN();
    }
    if (nets.length === 0 || !allowed(request.headers.get("CF-Connecting-IP"), nets)) return FORBIDDEN();
    return env.ASSETS.fetch(request);
  },
};
