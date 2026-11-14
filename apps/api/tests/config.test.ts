import { readInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProductionConfig,
  DEV_SEED_EMAIL,
  readApiConfig,
  readEventsConfig,
} from "../src/infrastructure/config";
import { LEGAL_SLUGS } from "@openedbot/contracts-api";
import { PLUGIN_API_VERSION, type ProPlugin } from "@openedbot/platform-plugins";
import { assertProPluginProductionEnv, loadApiProPlugins } from "../src/application/pro-plugins";
import { mobileConnectJoinUrl } from "../src/routes/identity/mobile-connect-routes";

/** A neutral payment webhook path a fixture billing plug-in declares (step 11.5). */
const PAY_PATH = "/api/pay/webhook";

const vapidPublic = (() => {
  const bytes = Buffer.alloc(65, 7);
  bytes[0] = 0x04;
  return bytes.toString("base64url");
})();
const vapidPrivate = Buffer.alloc(32, 9).toString("base64url");

const production = {
  OPENEDBOT_ENV: "production",
  API_PUBLIC_URL: "https://api.openedbot.example",
  WEB_APP_URL: "https://app.openedbot.example",
  API_DATABASE_URL: "postgres://api:secret@db/openedbot",
  RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  EVENTS_INTERNAL_TOKEN: "events-secret",
  RELAY_INTERNAL_TOKEN: "relay-secret",
  INVENTORY_INTERNAL_TOKEN: "inventory-secret",
  RUN_KEY_SECRET: "run-key-secret",
  METRICS_INTERNAL_TOKEN: "metrics-secret",
  BLOB_DRIVER: "r2",
  R2_BUCKET: "private",
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  FILES_CDN_URL: "https://files.openedbot.example",
  FILES_CDN_SIGNING_KEY: "signing-secret",
  API_TRUST_PROXY: "1",
  PUSH_VAPID_PUBLIC_KEY: vapidPublic,
  PUSH_VAPID_PRIVATE_KEY: vapidPrivate,
  PUSH_VAPID_SUBJECT: "mailto:ops@openedbot.example",
  // The link's proof of possession and the verdict key are
  // production guards; the fixture satisfies them so the later guards
  // (legal documents…) stay reachable.
  RUNTIME_LINK_REQUIRE_POP: "1",
  AUDIT_VERDICT_SIGNING_KEY: Buffer.alloc(32, 3).toString("base64"),
};

const development = {
  OPENEDBOT_ENV: "development",
  RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};

describe("sécurité du lien et clé de verdict", () => {
  test("hors production, la preuve de possession n'est pas exigée et la clé de verdict est éphémère", () => {
    const config = readApiConfig(development);
    expect(config.linkSecurity.requirePop).toBe(false);
    expect(config.auditVerdictSigning.ephemeral).toBe(true);
    expect(config.auditVerdictSigning.seed.byteLength).toBe(32);
    expect(readApiConfig({ ...development, RUNTIME_LINK_REQUIRE_POP: "1" }).linkSecurity.requirePop).toBe(true);
  });

  test("en production, RUNTIME_LINK_REQUIRE_POP=1 est obligatoire et vaut par défaut", () => {
    expect(() => assertProductionConfig(readApiConfig({ ...production, RUNTIME_LINK_REQUIRE_POP: "0" }))).toThrow(/RUNTIME_LINK_REQUIRE_POP=1 is required/);
    expect(readApiConfig({ ...production, RUNTIME_LINK_REQUIRE_POP: undefined }).linkSecurity.requirePop).toBe(true);
  });

  test("en production, NATIVE_API_PUBLIC_URL (origine du QR mobile) est en HTTPS", () => {
    expect(() => assertProductionConfig(readApiConfig({ ...production, NATIVE_API_PUBLIC_URL: "http://api.openedbot.example" }))).toThrow(/NATIVE_API_PUBLIC_URL must use HTTPS/);
    expect(readApiConfig({ ...production, NATIVE_API_PUBLIC_URL: "https://native.openedbot.example/" }).nativeApiPublicUrl).toBe("https://native.openedbot.example");
  });

  test("en production, une clé de verdict éphémère est refusée ; une graine mal formée aussi", () => {
    expect(() => assertProductionConfig(readApiConfig({ ...production, AUDIT_VERDICT_SIGNING_KEY: undefined }))).toThrow(/AUDIT_VERDICT_SIGNING_KEY is required/);
    expect(() => readApiConfig({ ...production, AUDIT_VERDICT_SIGNING_KEY: "short" })).toThrow(/AUDIT_VERDICT_SIGNING_KEY must be 32 bytes/);
    const signed = readApiConfig(production);
    expect(signed.auditVerdictSigning.ephemeral).toBe(false);
    // The next guard is the legal documents: the verdict key has been passed.
    expect(() => assertProductionConfig(signed)).toThrow(/LEGAL_MENTIONS_FILE/);
  });
});

describe("production configuration", () => {
  test("stores attachments in R2 when it is configured", () => {
    const config = readApiConfig(production);
    expect(config.blob.driver).toBe("r2");
  });

  test("falls back to the server volume when R2 is not configured, and says why", () => {
    // The neutralized provisioning values (Ansible role openedbot_alpha): before, every send ended in 500.
    const neutralized = readApiConfig({
      ...production,
      R2_ENDPOINT: "https://r2.invalid",
      R2_BUCKET: "alpha-r2-not-provisioned",
      R2_ACCESS_KEY_ID: "alpha-r2-not-provisioned",
      R2_SECRET_ACCESS_KEY: "alpha-r2-not-provisioned",
    });
    expect(neutralized.blob).toMatchObject({ driver: "file", root: "/var/lib/openedbot/blobs" });
    expect(neutralized.blob.driver === "file" && neutralized.blob.fallbackReason).toMatch(/R2 non configuré/);
    const missing = readApiConfig({ ...production, R2_SECRET_ACCESS_KEY: undefined });
    expect(missing.blob.driver).toBe("file");
    // The disk chosen explicitly is not a fallback: nothing to announce.
    const chosen = readApiConfig({ ...production, BLOB_DRIVER: "file", BLOB_FILE_ROOT: "/data/blobs" });
    expect(chosen.blob).toMatchObject({ driver: "file", root: "/data/blobs", fallbackReason: null });
    expect(() => readApiConfig({ ...production, BLOB_DRIVER: "s3" })).toThrow(/BLOB_DRIVER must be either file or r2/);
  });

  test("requires deployment-owned legal documents", () => {
    expect(() => assertProductionConfig(readApiConfig(production))).toThrow(/LEGAL_MENTIONS_FILE/);
  });

  // The outbound SSH channel no longer exists at all, and the variable that
  // configured administration is removed: in production as elsewhere, its
  // value is ignored and no channel opens.
  test("OPENEDBOT_ENV=preprod runs on production rules with the preprod label", () => {
    const config = readApiConfig({ ...production, OPENEDBOT_ENV: "preprod" });
    expect([config.environment, config.deployEnvironment]).toEqual(["production", "preprod"]);
    expect(readApiConfig(production).deployEnvironment).toBe("prod");
  });

  test("refuses an unknown OPENEDBOT_ENV instead of falling back to development", () => {
    for (const value of ["prod", "Production", "staging"]) {
      expect(() => readApiConfig({ ...production, OPENEDBOT_ENV: value })).toThrow(/OPENEDBOT_ENV must be one of/);
    }
    const { OPENEDBOT_ENV: _omitted, ...withoutEnv } = production;
    expect(() => readApiConfig({ ...withoutEnv, NODE_ENV: "prod" })).toThrow(/NODE_ENV must be one of/);
    expect(readApiConfig({ ...withoutEnv, NODE_ENV: "production" }).environment).toBe("production");
  });

  test("opens no administration channel in production", () => {
    const config = readApiConfig(production);
    expect(config.runtimeAdminChannels).toEqual({ local: false });
    expect(() => assertProductionConfig(config)).not.toThrow(/administration|ADMIN_MODE/i);
  });

  test("requires an HTTPS web URL: the payment provider returns the browser there", () => {
    expect(() => assertProductionConfig(readApiConfig({
      ...production,
      WEB_APP_URL: "http://app.openedbot.example",
    }))).toThrow(/WEB_APP_URL/);
  });

  // WEB_APP_URL is the canonical origin and CORS_ALLOWED_ORIGINS only adds
  // tolerated origins: no reordering of the list can
  // move the payment provider's return URLs.
  test("keeps the canonical origin independent of the extra CORS origins", () => {
    const config = readApiConfig({
      ...production,
      CORS_ALLOWED_ORIGINS: "https://legacy.openedbot.example,https://old.openedbot.example",
    });
    expect(config.webUrl).toBe("https://app.openedbot.example");
    expect(config.webOrigins).toEqual([
      "https://app.openedbot.example",
      "https://legacy.openedbot.example",
      "https://old.openedbot.example",
    ]);
  });

  test("never lists the canonical origin twice when it is repeated in CORS_ALLOWED_ORIGINS", () => {
    const config = readApiConfig({
      ...production,
      CORS_ALLOWED_ORIGINS: "https://app.openedbot.example,https://legacy.openedbot.example",
    });
    expect(config.webOrigins).toEqual(["https://app.openedbot.example", "https://legacy.openedbot.example"]);
  });

  // The internal secrets are read apart from ApiConfig (S1b, internal-secrets.ts).
  test("rejects a development internal secret in production", () => {
    expect(() => readInternalSecrets("api", "production", {
      ...production,
      RELAY_INTERNAL_TOKEN: "openedbot-relay-dev-token",
    })).toThrow(/RELAY_INTERNAL_TOKEN must not be a development default/);
  });

  // The connector link limits WebSocket bring-ups per client IP; behind
  // the TLS proxy without X-Forwarded-For, every host shares the proxy IP.
  test("requires API_TRUST_PROXY behind the production proxy", () => {
    expect(() => assertProductionConfig(readApiConfig({
      ...production,
      API_TRUST_PROXY: "",
    }))).toThrow(/API_TRUST_PROXY/);
  });

  test("requires a dedicated production metrics token", () => {
    expect(() => assertProductionConfig(readApiConfig({
      ...production,
      METRICS_INTERNAL_TOKEN: "openedbot-metrics-dev-token",
    }))).toThrow(/METRICS_INTERNAL_TOKEN/);
    expect(() => readInternalSecrets("api", "production", {
      ...production,
      METRICS_INTERNAL_TOKEN: production.RUN_KEY_SECRET,
    })).toThrow(/METRICS_INTERNAL_TOKEN/);
  });

  test("requires VAPID keys in production", () => {
    expect(() => assertProductionConfig(readApiConfig({
      ...production,
      PUSH_VAPID_PUBLIC_KEY: "",
      PUSH_VAPID_PRIVATE_KEY: "",
      PUSH_VAPID_SUBJECT: "",
    }))).toThrow(/PUSH_VAPID/);
  });

  test("development without VAPID leaves push disabled", () => {
    expect(readApiConfig(development).vapid).toBeNull();
  });

  test("the loopback Web Push opt-in is refused in production", () => {
    expect(() => readApiConfig({ ...production, PUSH_ALLOW_LOOPBACK_ENDPOINTS: "1" }))
      .toThrow(/PUSH_ALLOW_LOOPBACK_ENDPOINTS/);
  });

  test("the displayed price defaults to 19 € and reads BILLING_PRICE_EUR", () => {
    expect(readApiConfig(production).billingPriceEur).toBe(19);
    expect(readApiConfig({ ...production, BILLING_PRICE_EUR: "29" }).billingPriceEur).toBe(29);
  });
});

describe("canaux d’administration du déploiement", () => {
  // Without Dashboard, no channel remains: the old SSH fallback disappeared
  // with the code that opened it.
  test("sans identifiants de Dashboard, aucun canal n’existe", () => {
    expect(readApiConfig(development).runtimeAdminChannels).toEqual({ local: false });
  });

  test("requires a strong runtime token encryption key in development", () => {
    expect(() => readApiConfig({ OPENEDBOT_ENV: "development" })).toThrow(/RUNTIME_TOKEN_ENCRYPTION_KEY/);
  });

  test("does not keep a hardcoded former development encryption key", () => {
    const config = readApiConfig(development);
    expect(config.tokenEncryption.current.value).toEqual(Buffer.alloc(32, 9));
    expect(config.tokenEncryption.previous).toEqual([]);
  });

  test("does not invent a lab Hermes URL when DEV_HERMES_URL is absent", () => {
    expect(readApiConfig(development).developmentHermesUrl).toBe("");
  });

  test("declares no cleartext origin unless the deployment asks for one", () => {
    expect(readApiConfig(development).hermesEndpointPolicy.insecureOrigins?.size ?? 0).toBe(0);
  });

  test("accepts an explicitly declared development origin", () => {
    const config = readApiConfig({
      ...development,
      HERMES_ALLOW_INSECURE_ORIGINS: "10.0.0.10:8642",
      DEV_HERMES_URL: "http://10.0.0.10:8642",
    });
    expect(config.developmentHermesUrl).toBe("http://10.0.0.10:8642");
  });

  test("refuses a wildcard origin at startup rather than widening the guard", () => {
    expect(() =>
      readApiConfig({ ...development, HERMES_ALLOW_INSECURE_ORIGINS: "198.51.100.*:8642" }),
    ).toThrow(/joker|CIDR/);
  });

  test("refuses any cleartext origin in production", () => {
    const config = readApiConfig({ ...production, HERMES_ALLOW_INSECURE_ORIGINS: "10.0.0.1:8642" });
    expect(() => assertProductionConfig(config)).toThrow(/HERMES_ALLOW_INSECURE_ORIGINS/);
  });
});

describe("development sign-in", () => {
  test("never falls back to a versioned password: without one, nothing is published", () => {
    const { E2E_PASSWORD: _owner, ...withoutPasswords } = development as Record<string, string>;
    expect(readApiConfig(withoutPasswords).devSignIn).toBeNull();
    expect(readApiConfig({ ...withoutPasswords, E2E_PASSWORD: "generated-owner" }).devSignIn).toEqual({
      email: DEV_SEED_EMAIL,
      password: "generated-owner",
    });
  });

  test("publishes no back-office account: that sign-in left the core", () => {
    expect(Object.hasOwn(readApiConfig({ ...development, DEV_STAFF_PASSWORD: "ignored" }), "staffDevSignIn")).toBe(false);
  });
});

describe("Computer provider configuration", () => {
  test("is fail-closed by default", () => {
    expect(readApiConfig(development).computer).toEqual({ provider: "disabled" });
  });

  test("the environment-owned Box token alone enables the provider", () => {
    expect(readApiConfig({ ...development, OPENEDBOT_COMPUTER_BOX_TOKEN: " " }).computer).toEqual({ provider: "disabled" });
    expect(readApiConfig({
      ...development,
      OPENEDBOT_COMPUTER_BOX_TOKEN: "box_secret",
    }).computer).toEqual({
      provider: "box",
      apiUrl: "https://ascii.dev/api/box/v1",
      token: "box_secret",
    });
  });

  test("only lets tests override Box with a loopback fixture", () => {
    const configured = readApiConfig({
      ...development,
      OPENEDBOT_ENV: "test",
      OPENEDBOT_COMPUTER_BOX_TOKEN: "box_secret",
      TEST_COMPUTER_BOX_API: "http://127.0.0.1:18799/provider/",
    });
    expect(configured.computer).toMatchObject({ apiUrl: "http://127.0.0.1:18799/provider" });
    expect(() => readApiConfig({
      ...development,
      OPENEDBOT_ENV: "test",
      OPENEDBOT_COMPUTER_BOX_TOKEN: "box_secret",
      TEST_COMPUTER_BOX_API: "https://attacker.example/provider",
    })).toThrow(/loopback/);
  });
});

describe("development web origins", () => {
  test("defaults the browser and OAuth callback to localhost", () => {
    const config = readApiConfig({
      OPENEDBOT_ENV: "development",
      RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    });

    expect(config.publicUrl).toBe("http://localhost:8790");
    expect(config.webUrl).toBe("http://localhost:1420");
    expect(config.webOrigins).toEqual(["http://localhost:1420"]);
    expect(config.browserOrigins).toEqual(["http://localhost:1420"]);
  });

  test("CORS allows the web origins only: no other origin is added on its own", () => {
    const config = readApiConfig({
      OPENEDBOT_ENV: "development",
      RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      ADMIN_PUBLIC_URL: "http://admin.local:1421",
      CORS_ALLOWED_ORIGINS: "http://extra.local:1500",
    });
    expect(config.browserOrigins).toEqual(["http://localhost:1420", "http://extra.local:1500"]);
    expect(readApiConfig(production).browserOrigins).not.toContain("http://localhost:1421");
  });
});

describe("Hermes endpoint configuration", () => {
  test("loads one process-wide mTLS identity for every API runtime client", () => {
    const directory = mkdtempSync(join(tmpdir(), "openedbot-api-mtls-"));
    try {
      const cert = join(directory, "client.pem");
      const key = join(directory, "client.key");
      const ca = join(directory, "server-ca.pem");
      writeFileSync(cert, "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n", { mode: 0o644 });
      writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n", { mode: 0o640 });
      writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n", { mode: 0o644 });
      const config = readApiConfig({
        ...development,
        HERMES_MTLS_MODE: "required",
        HERMES_MTLS_CERT_FILE: cert,
        HERMES_MTLS_KEY_FILE: key,
        HERMES_MTLS_CA_FILE: ca,
      });
      expect(config.hermesMtls).toMatchObject({ cert: expect.stringContaining("client"), key: expect.stringContaining("key") });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses a development HTTP endpoint outside the explicit lab allowlist", () => {
    expect(() => readApiConfig({ ...development, DEV_HERMES_URL: "http://172.16.0.213:8642" })).toThrow(
      /HTTPS/,
    );
  });

  test("keeps a fake HTTP endpoint scoped to test", () => {
    expect(readApiConfig({
      OPENEDBOT_ENV: "test",
      RUNTIME_TOKEN_ENCRYPTION_KEY: development.RUNTIME_TOKEN_ENCRYPTION_KEY,
      TEST_HERMES_URL: "http://127.0.0.1:18642",
    }).testHermesUrl).toBe(
      "http://127.0.0.1:18642",
    );
  });
});

describe("flux d'événements", () => {
  test("le sondage de secours vaut 5 s et le rejeu de zéro est borné à 15 min / 200 événements", () => {
    expect(readEventsConfig({})).toEqual({
      fallbackPollMs: 5_000,
      replayWindowMs: 15 * 60_000,
      replayWindowEvents: 200,
    });
  });

  test("lit les trois variables et refuse un sondage sous 250 ms", () => {
    expect(readEventsConfig({
      API_EVENTS_FALLBACK_POLL_MS: "250",
      API_EVENTS_REPLAY_WINDOW_MS: "60000",
      API_EVENTS_REPLAY_WINDOW_EVENTS: "50",
    })).toEqual({ fallbackPollMs: 250, replayWindowMs: 60_000, replayWindowEvents: 50 });
    expect(() => readEventsConfig({ API_EVENTS_FALLBACK_POLL_MS: "100" })).toThrow(/API_EVENTS_FALLBACK_POLL_MS/);
    expect(() => readEventsConfig({ API_EVENTS_REPLAY_WINDOW_EVENTS: "0" })).toThrow(/API_EVENTS_REPLAY_WINDOW_EVENTS/);
  });
});

// Step 11.5: the payment provider's keys are the billing plug-in's
// deployment variables. A solo production start needs none; a pro start with
// billing loaded refuses to start without them.
describe("production start: payment keys only with the billing plug-in (step 11.5)", () => {
  const PROVIDER_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"] as const;
  const withLegalDocuments = <T,>(run: (env: Record<string, string>) => T): T => {
    const directory = mkdtempSync(join(tmpdir(), "openedbot-legal-"));
    try {
      for (const slug of LEGAL_SLUGS) writeFileSync(join(directory, `${slug}.md`), `# ${slug}\n\nDocument de déploiement.\n`);
      return run({ ...production, LEGAL_DOCUMENTS_DIR: directory });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const billing: ProPlugin = {
    manifest: {
      id: "billing", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [],
      env: PROVIDER_KEYS.map((name) => ({ name, requiredInProduction: true })),
    },
    billing: { webhookPath: PAY_PATH, webhook: async () => new Response(null, { status: 204 }) },
  };

  test("the production fixture carries no payment key", () => {
    for (const name of PROVIDER_KEYS) expect(Object.hasOwn(production, name), name).toBe(false);
  });

  test("solo production without any payment key starts", () => withLegalDocuments((env) => {
    expect(() => assertProductionConfig(readApiConfig(env))).not.toThrow();
    expect(() => assertProPluginProductionEnv([], env)).not.toThrow();
  }));

  test("pro production with billing loaded and no key refuses to start, naming each missing key", () => withLegalDocuments((env) => {
    expect(() => assertProductionConfig(readApiConfig(env))).not.toThrow();
    expect(() => assertProPluginProductionEnv([billing], env)).toThrow(
      "Required in production by the loaded plug-ins: billing: STRIPE_SECRET_KEY, billing: STRIPE_WEBHOOK_SECRET, billing: STRIPE_PRICE_ID.",
    );
    const keys = { STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_live_x", STRIPE_PRICE_ID: "price_live_x" };
    for (const name of PROVIDER_KEYS) {
      expect(() => assertProPluginProductionEnv([billing], { ...env, ...keys, [name]: "" })).toThrow(`billing: ${name}.`);
      expect(() => assertProPluginProductionEnv([billing], { ...env, ...keys, [name]: "   " })).toThrow(`billing: ${name}.`);
    }
    expect(() => assertProPluginProductionEnv([billing], { ...env, ...keys })).not.toThrow();
  }));

  test("an optional deployment variable is never required", () => {
    const optional: ProPlugin = { ...billing, manifest: { ...billing.manifest, env: [{ name: "PAY_REGION" }, { name: "PAY_MODE", requiredInProduction: false }] } };
    expect(() => assertProPluginProductionEnv([optional], {})).not.toThrow();
  });

  test("the API calls the check on the loaded plug-ins, in production, before the role guard", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const check = 'if (baseConfig.environment === "production") assertProPluginProductionEnv(loadedPro.plugins, process.env);';
    expect(source).toContain(check);
    expect(source.indexOf(check)).toBeGreaterThan(source.indexOf("const loadedPro = await loadApiProPlugins("));
    expect(source.indexOf(check)).toBeLessThan(source.indexOf("guardProPlugins(loadedPro.plugins"));
  });

  test("OPENEDBOT_REQUIRED_PLUGINS is checked on what the API finally keeps (after the role guard), before any route or port", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const check = "assertRequiredPlugins(process.env, installedPlugins, loadedPro.skipped);";
    expect(source).toContain(check);
    expect(source.indexOf(check)).toBeGreaterThan(source.indexOf("const installedPlugins: readonly ProPlugin[] = [...pro.plugins, ...legacyPlugins];"));
    expect(source.indexOf(check)).toBeLessThan(source.indexOf("installSubscriptionPort("));
    expect(source.indexOf(check)).toBeLessThan(source.indexOf("auditArchiveOf(installedPlugins)"));
    expect(source).toContain('event: "api.required_plugins_missing"');
  });

  test("the API refuses, in every environment, two loaded plug-ins declaring the same variable (step 11.5)", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const check = "\nassertDistinctPluginEnv(loadedPro.plugins);\n";
    expect(source).toContain(check);
    expect(source.indexOf(check)).toBeGreaterThan(source.indexOf("const loadedPro = await loadApiProPlugins("));
    expect(source.indexOf(check)).toBeLessThan(source.indexOf("assertProPluginProductionEnv(loadedPro.plugins"));
    expect(source.indexOf(check)).toBeLessThan(source.indexOf("guardProPlugins(loadedPro.plugins"));
  });

  test("the API loader refuses a plug-in declaring a core variable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openedbot-plugin-env-"));
    try {
      // Written before any import: the module resolver caches the directory.
      const names = ["API_DATABASE_URL", "BILLING_PRICE_EUR", "WEB_ORIGINS"];
      const entry = (name: string) => join(directory, `${name}.ts`);
      for (const name of names) {
        writeFileSync(entry(name), `export default { manifest: { id: "fixture", version: "1.0.0", pluginApi: ${PLUGIN_API_VERSION}, entitlements: [], env: [{ name: ${JSON.stringify(name)} }] } };\n`);
      }
      for (const name of names) {
        const { plugins, skipped } = await loadApiProPlugins(entry(name));
        expect(plugins).toEqual([]);
        expect(skipped[0]?.reason, name).toContain(`manifest.env "${name}" is a core variable`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("QR Mobile Connect en production (NATIVE_API_PUBLIC_URL)", () => {
  // Prod: console on console.openedbot.app, iOS build on api.openedbot.app
  // (Release.xcconfig OPENEDBOT_API_ORIGIN). The QR must name the latter.
  const split = { ...production, API_PUBLIC_URL: "https://console.openedbot.example", NATIVE_API_PUBLIC_URL: "https://api.openedbot.example/" };
  const qrApi = (env: Record<string, string | undefined>) =>
    new URL(mobileConnectJoinUrl(readApiConfig(env).nativeApiPublicUrl, "a.b")).searchParams.get("api");

  test("set, it is the origin the QR carries, not API_PUBLIC_URL", () => {
    expect(qrApi(split)).toBe("https://api.openedbot.example");
    expect(() => assertProductionConfig(readApiConfig(split))).not.toThrow(/NATIVE_API_PUBLIC_URL/);
  });

  test("unset, the QR carries API_PUBLIC_URL (single-name deployment)", () => {
    expect(qrApi({ ...production, NATIVE_API_PUBLIC_URL: undefined })).toBe("https://api.openedbot.example");
    expect(qrApi({ ...split, NATIVE_API_PUBLIC_URL: undefined })).toBe("https://console.openedbot.example");
  });

  test("a non-HTTPS value is refused at production startup", () => {
    for (const value of ["http://api.openedbot.example", "openedbot://api.openedbot.example"]) {
      expect(() => assertProductionConfig(readApiConfig({ ...split, NATIVE_API_PUBLIC_URL: value }))).toThrow(/NATIVE_API_PUBLIC_URL must use HTTPS in production/);
    }
  });
});

// Open-core boundary: the external audit archive belongs to the plug-in
// `audit`. A production start without any AUDIT_WORM_* variable is accepted
// (the local hash chain is the core's anchoring); a loaded `audit` plug-in
// that needs its archive's variables declares them (`manifest.env`).
describe("production start: no external audit archive is a core requirement", () => {
  const ARCHIVE_KEYS = ["AUDIT_WORM_BUCKET", "AUDIT_WORM_ENDPOINT", "AUDIT_WORM_WRITE_ACCESS_KEY_ID"] as const;
  const withLegalDocuments = <T,>(run: (env: Record<string, string>) => T): T => {
    const directory = mkdtempSync(join(tmpdir(), "openedbot-legal-"));
    try {
      for (const slug of LEGAL_SLUGS) writeFileSync(join(directory, `${slug}.md`), `# ${slug}\n\nDocument de déploiement.\n`);
      return run({ ...production, LEGAL_DOCUMENTS_DIR: directory });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const audit: ProPlugin = {
    manifest: {
      id: "audit", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: ["audit.anchor"],
      env: ARCHIVE_KEYS.map((name) => ({ name, requiredInProduction: true })),
    },
    auditArchive: { id: "worm:r2", put: async () => undefined, get: async () => null },
  };

  test("the production fixture carries no AUDIT_WORM_* variable", () => {
    expect(Object.keys(production).filter((name) => name.startsWith("AUDIT_WORM_"))).toEqual([]);
  });

  test("readApiConfig + assertProductionConfig accept a production config without AUDIT_WORM_*", () => {
    withLegalDocuments((env) => {
      const config = readApiConfig(env);
      expect(config.environment).toBe("production");
      expect(Object.hasOwn(config, "auditWorm")).toBe(false);
      expect(() => assertProductionConfig(config)).not.toThrow();
      // Solo production requires no plug-in variable either.
      expect(() => assertProPluginProductionEnv([], env)).not.toThrow();
    });
  });

  test("an AUDIT_WORM_* value left in the environment is ignored by the core", () => {
    withLegalDocuments((env) => {
      expect(() => assertProductionConfig(readApiConfig({ ...env, AUDIT_WORM_MODE: "disabled" }))).not.toThrow();
    });
  });

  test("the plug-in audit may declare the archive's variables and require them in production", async () => {
    const loaded = await loadApiProPlugins("audit", { importer: async () => audit });
    expect(loaded.skipped).toEqual([]);
    expect(() => assertProPluginProductionEnv(loaded.plugins, production)).toThrow(/audit: AUDIT_WORM_BUCKET, audit: AUDIT_WORM_ENDPOINT, audit: AUDIT_WORM_WRITE_ACCESS_KEY_ID/);
    const complete = Object.fromEntries(ARCHIVE_KEYS.map((name) => [name, "set"]));
    expect(() => assertProPluginProductionEnv(loaded.plugins, { ...production, ...complete })).not.toThrow();
  });
});
