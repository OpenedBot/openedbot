import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

// The lab previews the REAL sign-in page: openedbot-desktop's src/renderer is served
// as-is at the root (/signin.html, /templates/*.css, /assets/*), so what the
// lab shows is what the app ships.
const renderer = path.resolve(__dirname, "../src/renderer");
const templatesDir = path.join(renderer, "templates");
const TEMPLATE_NAME = /^[a-z0-9-]{1,40}$/;
const VIRTUAL_ID = "virtual:ohb-templates";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

// Where the desktop app reads its user settings (config.ts, userData =
// "openedbot" on macOS). The lab's "use this template" writes signinTemplate there.
const userConfig = path.join(homedir(), "Library", "Application Support", "openedbot", "config.json");

type TemplateInfo = { name: string; description: string };

/** The template list, with the first comment of each file as its description. */
function readTemplates(): TemplateInfo[] {
  return readdirSync(templatesDir)
    .filter((file) => file.endsWith(".css") && TEMPLATE_NAME.test(file.slice(0, -4)))
    .sort()
    .map((file) => {
      const css = readFileSync(path.join(templatesDir, file), "utf8");
      const comment = /^\s*\/\*([\s\S]*?)\*\//.exec(css)?.[1] ?? "";
      const description = comment.split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
      return { name: file.slice(0, -4), description };
    });
}

function readUserConfig(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(userConfig, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function ohbLab(): Plugin {
  return {
    name: "ohb-lab",
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : null),
    load: (id) => (id === RESOLVED_ID ? `export default ${JSON.stringify(readTemplates())};` : null),
    configureServer(server: ViteDevServer) {
      // Live iteration: a saved template, base stylesheet, markup or asset
      // tells the previews to refresh; a new or removed template refreshes
      // the list too.
      server.watcher.add(renderer);
      const notify = (file: string, kind: "change" | "add" | "unlink"): void => {
        if (!file.startsWith(renderer)) return;
        const relative = path.relative(renderer, file);
        if (kind !== "change" && relative.startsWith("templates")) {
          const module = server.moduleGraph.getModuleById(RESOLVED_ID);
          if (module) server.moduleGraph.invalidateModule(module);
          server.ws.send({ type: "full-reload" });
          return;
        }
        server.ws.send({ type: "custom", event: "ohb:renderer-changed", data: { file: relative, at: Date.now() } });
      };
      server.watcher.on("change", (file) => notify(file, "change"));
      server.watcher.on("add", (file) => notify(file, "add"));
      server.watcher.on("unlink", (file) => notify(file, "unlink"));

      server.middlewares.use("/__lab/current", (_req, res) => {
        const chosen = readUserConfig().signinTemplate;
        sendJson(res, 200, { template: typeof chosen === "string" ? chosen : null, configPath: userConfig });
      });

      // Writes only signinTemplate, keeps every other key of the user's file.
      server.middlewares.use("/__lab/choose", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          let name: unknown;
          try {
            name = (JSON.parse(body) as { name?: unknown }).name;
          } catch {
            return sendJson(res, 400, { error: "invalid JSON" });
          }
          if (typeof name !== "string" || !TEMPLATE_NAME.test(name) || !existsSync(path.join(templatesDir, `${name}.css`))) {
            return sendJson(res, 400, { error: "unknown template" });
          }
          const next = { ...readUserConfig(), signinTemplate: name };
          mkdirSync(path.dirname(userConfig), { recursive: true });
          writeFileSync(userConfig, `${JSON.stringify(next, null, 2)}\n`);
          sendJson(res, 200, { template: name, configPath: userConfig });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ohbLab()],
  publicDir: renderer,
  server: {
    port: 5317,
    strictPort: false,
    fs: { allow: [path.resolve(__dirname, "..")] },
  },
});
