import { describe, expect, test } from "bun:test";
import {
  connectorLinkCommand,
  connectorLinkPublicOrigin,
  connectorOHBOrigin,
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

    expect(command).toBe("edge-setup link --ohb https://api.example.com --yes");
    expect(command).not.toContain(ticket);
  });

  test("names the development flag for a loopback origin, never for a public one", () => {
    expect(connectorLinkCommand("http://localhost:8790")).toBe(
      "edge-setup link --ohb http://127.0.0.1:8790 --yes --insecure-ohb",
    );
    expect(connectorLinkCommand("http://[::1]:8790")).toBe(
      "edge-setup link --ohb http://127.0.0.1:8790 --yes --insecure-ohb",
    );
    expect(connectorLinkCommand("http://127.0.0.1:8790")).toContain("--insecure-ohb");
    expect(connectorLinkCommand("http://ohb.example")).not.toContain("--insecure-ohb");
    expect(connectorLinkCommand("https://api.example.com")).not.toContain("--insecure-ohb");
  });

  test("uses the HTTPS browser origin for a Cloudflare development tunnel", () => {
    const config = { environment: "development" as const, publicUrl: "http://localhost:8790" };

    expect(connectorOHBOrigin(config, "https://random-name.trycloudflare.com")).toBe(
      "https://random-name.trycloudflare.com",
    );
  });

  test("does not trust an insecure or malformed development origin", () => {
    const config = { environment: "development" as const, publicUrl: "http://localhost:8790" };

    expect(connectorOHBOrigin(config, "http://attacker.example")).toBe(config.publicUrl);
    expect(connectorOHBOrigin(config, "https://good.example/path")).toBe(config.publicUrl);
  });

  test("names the dedicated link origin when one is set, the API origin otherwise", () => {
    const config = { environment: "production" as const, publicUrl: "https://ohb.example", linkPublicUrl: "https://link.ohb.example" };
    expect(connectorLinkPublicOrigin(config, "https://attacker.example")).toBe("https://link.ohb.example");
    expect(connectorLinkPublicOrigin({ ...config, linkPublicUrl: "https://ohb.example" }, undefined)).toBe("https://ohb.example");
    // MCP OAuth callbacks keep using the API origin, never the link host.
    expect(connectorOHBOrigin(config, undefined)).toBe("https://ohb.example");
  });

  test("keeps the deployment-owned origin in production", () => {
    const config = { environment: "production" as const, publicUrl: "https://api.ohb.example" };

    expect(connectorOHBOrigin(config, "https://attacker.example")).toBe(config.publicUrl);
  });
});
