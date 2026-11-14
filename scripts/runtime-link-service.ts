import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export const serviceName = "openedbot-runtime-link-gateway.service";
function unitPath(value: string, expandVariables = false): string {
  if (!isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error("Expected an absolute single-line service path");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => expandVariables ? "$$" : "$")}"`;
}
export function renderRuntimeLinkUnit(appDir: string, bunPath: string): string {
  unitPath(appDir); // Validate the unquoted WorkingDirectory setting too.
  return `[Unit]
Description=openedbot persistent Hermes link gateway
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${appDir.replaceAll("%", "%%")}
ExecStart=/bin/bash ${unitPath(join(appDir, "scripts/runtime-link-launch.sh"), true)} ${unitPath(bunPath, true)}
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
KillMode=control-group
TimeoutStopSec=330
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=openedbot-runtime-link-gateway

[Install]
WantedBy=default.target
`;
}
if (import.meta.main) {
  const action = process.argv[2] ?? "--print";
  if (!["--print", "--install"].includes(action)) throw new Error("Use --print or --install");
  const appDir = resolve(import.meta.dir, "..");
  const unit = renderRuntimeLinkUnit(appDir, process.execPath);
  if (action === "--print") process.stdout.write(unit);
  else {
    if (process.platform !== "linux") throw new Error("The user service requires Linux/systemd");
    const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const destination = join(configDir, "systemd/user", serviceName);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await Bun.write(destination, unit, { mode: 0o600 });
    const reload = Bun.spawn(["systemctl", "--user", "daemon-reload"], { stdout: "inherit", stderr: "inherit" });
    if (await reload.exited !== 0) throw new Error("Service file installed but systemd reload failed");
    console.info(JSON.stringify({ installed: destination, started: false, enabled: false }));
  }
}
