import type { Server } from "bun";
import { invariant } from "./p1-evidence";


/** Hermes 0.23 tools/mcp_tool_schema.py uses mcp__<server>__<tool>. */
export function mcpProbeToolName(server: string): string {
  invariant(/^[A-Za-z0-9_-]{1,40}$/.test(server), "The owned probe server name is outside the unclamped native MCP name contract.");
  return `mcp__${server}__read_probe`;
}

/** A private, stateless MCP server: the model only learns `secret` via tools/call. */
export class McpFixture {
  readonly namespace = crypto.randomUUID();
  readonly secret = `MCP_${crypto.randomUUID().replaceAll("-", "")}`;
  readonly calls: Array<{ challenge: string; succeeded: boolean }> = [];
  online = true;
  private server: Server<undefined> | null = null;

  start(port: number, hostname = "127.0.0.1"): void {
    invariant(this.server === null, "MCP fixture is already running.");
    this.server = Bun.serve({ hostname, port, maxRequestBodySize: 16_384, fetch: (request) => this.handle(request) });
  }
  stop(): void { this.server?.stop(true); this.server = null; }

  url(origin: string): string {
    const base = new URL(origin);
    invariant(base.protocol === "https:" && base.pathname === "/" && !base.username && !base.password && !base.search && !base.hash, "The controlled MCP fixture requires an HTTPS E2E_FIXTURE_ORIGIN at its origin, without a path, credentials, query or fragment.");
    return `${origin.replace(/\/+$/, "")}/${this.namespace}/mcp`;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== `/${this.namespace}/mcp`) return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: request.method === "GET" ? 405 : 400 });
    if (Number(request.headers.get("content-length") ?? 0) > 16_384) return new Response(null, { status: 413 });
    let body: unknown;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > 16_384) return new Response(null, { status: 413 });
      body = JSON.parse(text);
    } catch { return new Response(null, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(null, { status: 400 });
    const rpc = body as Record<string, unknown>;
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return new Response(null, { status: 400 });
    if (!Object.hasOwn(rpc, "id")) return new Response(null, { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    switch (rpc.method) {
      case "initialize": return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "openedbot-owned-e2e", version: "1.0.0" } });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: [{ name: "read_probe", description: "Read the private acceptance probe. Returns a secret only from this server.",
        inputSchema: { type: "object", properties: { challenge: { type: "string" } }, required: ["challenge"], additionalProperties: false } }] });
      case "tools/call": {
        const params = rpc.params as { name?: unknown; arguments?: { challenge?: unknown } } | undefined;
        if (params?.name !== "read_probe" || typeof params.arguments?.challenge !== "string" || params.arguments.challenge.length > 100) {
          return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Invalid probe arguments" } });
        }
        this.calls.push({ challenge: params.arguments.challenge, succeeded: this.online });
        return reply({ content: [{ type: "text", text: this.online ? this.secret : "E2E_FIXTURE_UNAVAILABLE" }], ...(this.online ? {} : { isError: true }) });
      }
      default: return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
    }
  }
}
