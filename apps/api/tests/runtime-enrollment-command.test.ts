import { describe, expect, test } from "bun:test";
import {
  connectorLinkCommand,
  connectorLinkPublicOrigin,
  connectorOpenedbotOrigin,
  readEnrollmentReachability,
} from "../src/routes/runtimes/runtime-enrollment-routes";

describe("connector enrollment command", () => {
  test("defaults enrollment to connector and rejects the removed direct mode", () => {
    expect(readEnrollmentReachability(undefined)).toBe("connector");
    expect(readEnrollmentReachability("connector")).toBe("connector");
    expect(() => readEnrollmentReachability("direct")).toThrow(/connexion sortante sécurisée/i);
  });

  test("never puts the one-time ticket in argv", () => {
    const ticket = "7d2f5a10-4242-4e2e-9c3a-52f2a5d0c001.s3cr3t-lien";
    const command = connectorLinkCommand("https://api.example.com/");

    expect(command).toBe("edge-setup link --openedbot https://api.example.com --yes");
    expect(command).not.toContain(ticket);
  });

  test("names the development flag for a loopback origin, never for a public one", () => {
    expect(connectorLinkCommand("http://localhost:8790")).toBe(
      "edge-setup link --openedbot http://127.0.0.1:8790 --yes --insecure-openedbot",
    );
    expect(connectorLinkCommand("http://[::1]:8790")).toBe(
      "edge-setup link --openedbot http://127.0.0.1:8790 --yes --insecure-openedbot",
    );
    expect(connectorLinkCommand("http://127.0.0.1:8790")).toContain("--insecure-openedbot");
    expect(connectorLinkCommand("http://openedbot.example")).not.toContain("--insecure-openedbot");
    expect(connectorLinkCommand("https://api.example.com")).not.toContain("--insecure-openedbot");
  });

  test("uses the HTTPS browser origin for a Cloudflare development tunnel", () => {
    const config = { environment: "development" as const, publicUrl: "http://localhost:8790" };

    expect(connectorOpenedbotOrigin(config, "https://random-name.trycloudflare.com")).toBe(
      "https://random-name.trycloudflare.com",
    );
  });

  test("does not trust an insecure or malformed development origin", () => {
    const config = { environment: "development" as const, publicUrl: "http://localhost:8790" };

    expect(connectorOpenedbotOrigin(config, "http://attacker.example")).toBe(config.publicUrl);
    expect(connectorOpenedbotOrigin(config, "https://good.example/path")).toBe(config.publicUrl);
  });

  test("names the dedicated link origin when one is set, the API origin otherwise", () => {
    const config = { environment: "production" as const, publicUrl: "https://openedbot.example", linkPublicUrl: "https://link.openedbot.example" };
    expect(connectorLinkPublicOrigin(config, "https://attacker.example")).toBe("https://link.openedbot.example");
    expect(connectorLinkPublicOrigin({ ...config, linkPublicUrl: "https://openedbot.example" }, undefined)).toBe("https://openedbot.example");
    // MCP OAuth callbacks keep using the API origin, never the link host.
    expect(connectorOpenedbotOrigin(config, undefined)).toBe("https://openedbot.example");
  });

  test("keeps the deployment-owned origin in production", () => {
    const config = { environment: "production" as const, publicUrl: "https://api.openedbot.example" };

    expect(connectorOpenedbotOrigin(config, "https://attacker.example")).toBe(config.publicUrl);
  });
});
