/** Only normalized evidence is retained; no response header values or bodies escape. */
export type DirectResponseEvidence = {
  status: number;
  contentType: string | null;
  cloudflare: boolean;
  accessRedirect: boolean;
  cloudflareCode: "1033" | null;
  gatewayAuth: boolean;
};
const responseEvidence = new WeakMap<Error, DirectResponseEvidence>();

function boundedResponseEvidence(response: Response, body = ""): DirectResponseEvidence {
  const rawType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentType = ["application/json", "text/html", "text/plain", "application/problem+json"].includes(rawType ?? "") ? rawType! : null;
  let cloudflare = response.headers.get("server")?.toLowerCase() === "cloudflare";
  response.headers.forEach((_value, name) => { if (name.startsWith("cf-")) cloudflare = true; });
  let accessRedirect = false;
  try {
    const location = new URL(response.headers.get("location") ?? "");
    accessRedirect = response.status >= 300 && response.status < 400
      && location.protocol === "https:" && location.hostname.endsWith(".cloudflareaccess.com");
  } catch { /* No valid Access redirect. */ }
  let gatewayAuth = false;
  if (contentType === "application/json") {
    try {
      const json = JSON.parse(body);
      const code = typeof json?.error === "string" ? json.error : json?.error?.code ?? json?.code;
      gatewayAuth = ["unauthorized", "invalid_api_key", "invalid_api_server_key", "authentication_required", "Invalid API key", "Invalid or missing API key"].includes(code);
    } catch { /* An arbitrary JSON response is not gateway evidence. */ }
  }
  return { status: response.status, contentType, cloudflare, accessRedirect,
    cloudflareCode: cloudflare && /(?:error\s*(?:code)?\s*[:=]?\s*|<[^>]+>\s*)1033\b/i.test(body) ? "1033" : null,
    gatewayAuth };
}

/** Evidence recorded for `error` by the client, if any. */
export function directResponseEvidence(error: unknown): DirectResponseEvidence | null {
  return error instanceof Error ? responseEvidence.get(error) ?? null : null;
}

/** Remember the bounded evidence of the response that produced `error`. */
export function recordResponseEvidence(error: Error, response: Response, body = ""): void {
  responseEvidence.set(error, boundedResponseEvidence(response, body));
}
