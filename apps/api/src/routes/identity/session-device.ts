import type { Context } from "hono";
import type { SessionDevice } from "@openedbot/identity/application/sessions";
import type { ApiConfig } from "../../infrastructure/config";
import { requestClientIp } from "../../interfaces/http/rate-limit";

/**
 * Share rate limiting's IP boundary: forwarded headers are trusted only behind
 * the configured proxy; otherwise use the socket address. An absent socket
 * becomes null because sessions.ip is an inet column, not arbitrary text.
 */
export function sessionDevice(context: Context, config: Pick<ApiConfig, "trustProxy">): SessionDevice {
  const userAgent = context.req.header("user-agent")?.slice(0, 256) ?? null;
  const server = context.env as
    | { requestIP?: (request: Request) => { address: string } | null }
    | undefined;
  const ip = requestClientIp(context.req.raw, server, config.trustProxy);
  return { userAgent, ip: ip === "unknown" ? null : ip };
}
