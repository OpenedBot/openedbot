import { describe, expect, test } from "bun:test";
import { gatewayStaleness, localCredentials, planLinkDev, remoteConnectorRestartCommand, remoteConnectorStopped, remoteLinkCommand, remoteLinkState, remoteShell, workstationInstance, workstationPort, WORKSTATION_PORT_BASE, WORKSTATION_PORT_SPAN } from "./link-dev";

describe("planLinkDev", () => {
  test("embedded forwards the API port, separate forwards the link listener", () => {
    expect(planLinkDev({ LINK_TUNNEL_PORT: "8790" })).toMatchObject({ mode: "embedded", localPort: 8790, remotePort: 8790, healthPath: "/api/health", apiPort: 8790 });
    expect(planLinkDev({ RUNTIME_LINK_MODE: "separate", RUNTIME_LINK_PORT: "8791", API_PORT: "8790" })).toMatchObject({
      mode: "separate", localPort: 8791, apiPort: 8790, healthPath: "/health",
    });
  });

  test("the connector dials the IPv4 loopback, never localhost", () => {
    expect(planLinkDev({ LINK_TUNNEL_PORT: "8790" }).remoteOrigin).toBe("http://127.0.0.1:8790");
  });

  test("without a setting, each workstation gets its own instance and VPS port", () => {
    const devbox = planLinkDev({}, { hostname: "devbox-01" });
    const mac = planLinkDev({}, { hostname: "Dev-MacBook-Pro.local" });
    expect(devbox.instance).toBe("devbox-01");
    expect(mac.instance).toBe("dev-macbook-pro");
    expect(devbox.remotePort).not.toBe(mac.remotePort);
    expect(devbox.remoteOrigin).toBe(`http://127.0.0.1:${devbox.remotePort}`);
    expect(planLinkDev({}, { hostname: "devbox-01" }).remotePort).toBe(devbox.remotePort);
    expect(devbox.runtimeName).toBe("devbox-01 (poste)");
  });

  test("LINK_DEV_INSTANCE and LINK_TUNNEL_PORT still win over the workstation", () => {
    expect(planLinkDev({ LINK_DEV_INSTANCE: "mac", LINK_TUNNEL_PORT: "8790" }, { hostname: "devbox-01" })).toMatchObject({ instance: "mac", remotePort: 8790 });
    expect(planLinkDev({ LINK_DEV_INSTANCE: "mac" }, { hostname: "devbox-01" }).remotePort).toBe(workstationPort("mac"));
  });

  test("`default` is the slot that flips modes, and names are validated", () => {
    expect(planLinkDev({}, { instance: "default" }).instance).toBe("default");
    expect(() => planLinkDev({}, { instance: "Prod!" })).toThrow(/invalide/u);
    expect(planLinkDev({}, { instance: "dev" }).instance).toBe("dev");
  });

  test("bad ports fail closed", () => {
    expect(() => planLinkDev({ RUNTIME_LINK_MODE: "other" })).toThrow(/RUNTIME_LINK_MODE/u);
    expect(() => planLinkDev({ API_PORT: "70000" })).toThrow(/hors limites/u);
  });
});

describe("workstationInstance", () => {
  test("a hostname becomes a valid edge-setup instance name", () => {
    expect(workstationInstance("devbox-01")).toBe("devbox-01");
    expect(workstationInstance("Dev-MacBook-Pro.local")).toBe("dev-macbook-pro");
    expect(workstationInstance("Poste de Camille")).toBe("poste-de-camille");
    expect(workstationInstance("42-box")).toBe("poste-42-box");
    expect(workstationInstance("a".repeat(40) + "-b")).toBe("a".repeat(32));
  });
  test("edge-setup reserved names and empty hostnames never come out as is", () => {
    expect(workstationInstance("default")).toBe("poste-default");
    expect(workstationInstance("runs")).toBe("poste-runs");
    expect(workstationInstance("")).toBe("poste");
    expect(workstationInstance("???")).toBe("poste");
  });
});

test("workstationPort is stable and stays in its VPS range", () => {
  for (const name of ["devbox-01", "dev-macbook-pro", "mac", "default", "poste"]) {
    const port = workstationPort(name);
    expect(port).toBe(workstationPort(name));
    expect(port).toBeGreaterThanOrEqual(WORKSTATION_PORT_BASE);
    expect(port).toBeLessThan(WORKSTATION_PORT_BASE + WORKSTATION_PORT_SPAN);
  }
});

test("remoteShell survives the second parse of the remote login shell", async () => {
  const script = `x='a b'; echo "$x" | tr ' ' '-'`;
  const argv = remoteShell(script);
  // What sshd hands the login shell: the argv joined with spaces.
  const child = Bun.spawn(["sh", "-c", argv.join(" ")], { stdout: "pipe" });
  expect((await new Response(child.stdout).text()).trim()).toBe("a-b");
});

describe("remoteLinkState", () => {
  const plan = planLinkDev({ LINK_TUNNEL_PORT: "8790" }, { instance: "mac" });
  test("linked to this tunnel: no ticket is spent", () => {
    const status = { connectors: [{ name: "default", link_present: true, openedbot: "https://console.openedbot.app" }, { name: "mac", link_present: true, openedbot: "http://127.0.0.1:8790/" }] };
    expect(remoteLinkState(status, plan)).toBe("linked");
  });
  test("absent or unlinked instance enrolls", () => {
    expect(remoteLinkState({ connectors: [{ name: "default", link_present: true, openedbot: "https://console.openedbot.app" }] }, plan)).toBe("absent");
    expect(remoteLinkState({ connectors: [{ name: "mac", link_present: false }] }, plan)).toBe("absent");
  });
  test("linked elsewhere is a takeover, not a refusal", () => {
    expect(remoteLinkState({ connectors: [{ name: "mac", link_present: true, openedbot: "https://other.example" }] }, plan)).toBe("elsewhere");
  });
  test("a pre-instance binary is refused", () => {
    expect(() => remoteLinkState({ connector_active: true }, plan)).toThrow(/upgrade/u);
  });
});

describe("remoteConnectorStopped", () => {
  const plan = planLinkDev({ LINK_TUNNEL_PORT: "8790" }, { instance: "mac" });
  test("a linked instance whose unit exited is stopped", () => {
    expect(remoteConnectorStopped({ connectors: [{ name: "mac", active: false, link_present: true, openedbot: "http://127.0.0.1:8790" }] }, plan)).toBe(true);
  });
  test("a running unit, or another instance stopped, is not", () => {
    expect(remoteConnectorStopped({ connectors: [{ name: "mac", active: true, link_present: true }, { name: "default", active: false }] }, plan)).toBe(false);
  });
  test("no `active` field or no connectors is never read as stopped", () => {
    expect(remoteConnectorStopped({ connectors: [{ name: "mac", link_present: true }] }, plan)).toBe(false);
    expect(remoteConnectorStopped({ connector_active: false }, plan)).toBe(false);
  });
});

test("remoteLinkCommand keeps the ticket out of argv and never asks for --replace", () => {
  const argv = remoteLinkCommand(planLinkDev({ LINK_TUNNEL_PORT: "8790" }, { instance: "dev" }));
  expect(argv).toEqual(["sudo", "-n", "edge-setup", "link", "--openedbot", "http://127.0.0.1:8790", "--yes", "--insecure-openedbot", "--name", "dev"]);
  // `default` is the instance edge-setup targets without --name: the slot
  // an operator flips between a development openedbot and production.
  expect(remoteLinkCommand(planLinkDev({ LINK_TUNNEL_PORT: "8790" }, { instance: "default" }))).toEqual(
    ["sudo", "-n", "edge-setup", "link", "--openedbot", "http://127.0.0.1:8790", "--yes", "--insecure-openedbot"],
  );
  expect(argv).not.toContain("--replace");
  expect(argv.join(" ")).not.toMatch(/ticket/u);
});

test("localCredentials prefers explicit overrides over the seeded account", () => {
  expect(() => localCredentials({})).toThrow(/E2E_PASSWORD/u);
  expect(localCredentials({ E2E_PASSWORD: "generated" })).toEqual({ email: "dev@openedbot.local", password: "generated" });
  expect(localCredentials({ E2E_EMAIL: "e2e@openedbot.local", E2E_PASSWORD: "x" }).email).toBe("e2e@openedbot.local");
  expect(localCredentials({ E2E_EMAIL: "e2e@openedbot.local", LINK_DEV_EMAIL: "me@openedbot.local", LINK_DEV_PASSWORD: "y" })).toEqual({ email: "me@openedbot.local", password: "y" });
});

describe("gatewayStaleness", () => {
  const t0 = Date.parse("2026-09-06T20:00:00Z");
  test("a gateway older than HEAD or than a migration is called out, nothing else", () => {
    expect(gatewayStaleness({ gatewayStartedAtMs: t0 + 60_000, headCommittedAtMs: t0, migrationMtimesMs: [t0 - 1] })).toEqual([]);
    expect(gatewayStaleness({ gatewayStartedAtMs: t0 - 1, headCommittedAtMs: t0, migrationMtimesMs: [] })).toHaveLength(1);
    expect(gatewayStaleness({ gatewayStartedAtMs: t0, headCommittedAtMs: t0 - 1, migrationMtimesMs: [t0 + 1] })[0]).toMatch(/db-migrate/u);
  });
  test("no gateway (embedded mode) means no hint", () => {
    expect(gatewayStaleness({ gatewayStartedAtMs: null, headCommittedAtMs: t0, migrationMtimesMs: [t0] })).toEqual([]);
  });
});

test("remoteConnectorRestartCommand names the unit of the linked instance only", () => {
  expect(remoteConnectorRestartCommand(planLinkDev({}, { instance: "mac" }))).toEqual(
    ["sudo", "-n", "systemctl", "restart", "hermes-connector@mac.service"],
  );
  expect(remoteConnectorRestartCommand(planLinkDev({}, { instance: "default" }))).toEqual(
    ["sudo", "-n", "systemctl", "restart", "hermes-connector.service"],
  );
});
