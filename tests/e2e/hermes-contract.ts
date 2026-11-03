import {
  HermesClient,
  HermesClientError,
  readHermesMtlsIdentity,
} from "@openedbot/hermes";
import { runtimeToolsetContractViolation } from "../../modules/runtimes/src/domain/runtime-contract.ts";
import { parseInsecureHermesOrigins } from "../../platform/hermes/src/endpoint.ts";

// No implied lab URL: the canary targets exactly the runtime the operator
// declares, over HTTPS or over an origin explicitly allowed in cleartext.
const endpoint = process.env.DEV_HERMES_URL?.trim() ?? "";
if (!endpoint) throw new Error("DEV_HERMES_URL is required for the live Hermes contract.");
const endpointUrl = new URL(endpoint);
const insecureOrigins = parseInsecureHermesOrigins(process.env.HERMES_ALLOW_INSECURE_ORIGINS);
if (
  endpointUrl.protocol !== "https:" &&
  (endpointUrl.protocol !== "http:" || !insecureOrigins.has(endpointUrl.host))
) {
  throw new Error(
    "DEV_HERMES_URL must be https, or an http host:port listed in HERMES_ALLOW_INSECURE_ORIGINS.",
  );
}
const token = process.env.DEV_HERMES_TOKEN?.trim();
if (!token) throw new Error("DEV_HERMES_TOKEN is required for the live Hermes contract.");
const profile = process.env.DEV_HERMES_PROFILE?.trim() || null;
const client = new HermesClient({
  endpoint,
  token,
  profile,
  policy: { environment: "development", insecureOrigins },
  mtls: readHermesMtlsIdentity(),
});

try {
  const probe = await client.probe();
  const models = await client.models();
  const toolsets = await client.toolsets();
  // Read-only drift evidence. This deliberately does not register a browser
  // controller: transport compatibility alone never proves that the bot's Box
  // is bound to this run, and older gateways must remain a truthful
  // FEATURE_NOT_ADVERTISED instead of a simulated success.
  const browserControl = await client.browserControlTransportProbe();
  const violation = runtimeToolsetContractViolation(toolsets);
  if (violation) {
    throw new Error(`${violation.code}: ${violation.toolsets.join(", ") || "inventory unavailable"}`);
  }
  const options = await client.modelOptions();
  const requestedProvider = process.env.DEV_HERMES_PROVIDER?.trim() || null;
  const provider = options.providers.find((candidate) =>
    candidate.authenticated && candidate.models.length > 0 &&
    candidate.slug !== "moa" && (!requestedProvider || candidate.slug === requestedProvider)
  );
  if (!provider) throw new Error("No authenticated, non-virtual Hermes provider is available for the live canary.");
  const requestedModel = process.env.DEV_HERMES_MODEL?.trim() || options.model;
  const model = provider.models.find((candidate) => candidate.id === requestedModel) ?? provider.models[0];
  if (!model) throw new Error(`Provider ${provider.slug} exposes no model for the live canary.`);
  if (profile) await client.probeProfileIsolation(profile);
  const canaryId = crypto.randomUUID();
  const sessionId = `ohb-canary-${canaryId}`;
  await client.ensureSession(sessionId, `OHB canary ${canaryId.slice(0, 8)}`);
  const runId = await client.createRun({
    input: "Réponds exactement OPENEDBOT_CANARY_OK.",
    instructions: "Réponds sans outil et sans modifier le système.",
    sessionId,
    provider: provider.slug,
    model: model.id,
    idempotencyKey: canaryId,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let output = "";
  try {
    for await (const event of client.events(runId, controller.signal)) {
      if (event.event === "run.completed" && typeof event.output === "string") output = event.output;
      if (event.event === "run.failed" || event.event === "run.error") {
        throw new Error(`Hermes canary failed: ${String(event.message ?? event.error ?? "unknown")}`);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!output.includes("OPENEDBOT_CANARY_OK")) throw new Error(`Unexpected Hermes result: ${output.slice(0, 200)}`);
  console.info(JSON.stringify({
    event: "e2e.hermes_passed", endpoint, profile, models: models.length,
    capabilities: probe.capabilities, provider: provider.slug, model: model.id,
    toolsetsVerified: toolsets?.length ?? 0, browserControl, runId,
  }));
} catch (error) {
  if (error instanceof HermesClientError && (error.code === "HERMES_UNREACHABLE" || error.code === "HERMES_TLS_INVALID")) {
    console.error(JSON.stringify({ event: "e2e.hermes_unavailable", endpoint, code: error.code, message: error.message }));
    process.exit(20);
  }
  throw error;
}
