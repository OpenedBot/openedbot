import { HermesClientError, type HermesClient } from "@openedbot/hermes";
import { logger } from "@openedbot/platform-observability";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { runtimeToolsetContractMessage, runtimeToolsetContractViolation } from "@openedbot/runtimes/domain/runtime-contract";

/**
 * La sonde d'un runtime Hermes : santé, capacités et contrat des toolsets.
 * Partagée par les routes des runtimes et par l'enrôlement à travers le lien
 * connecteur, sans rien charger du routeur HTTP.
 */

/** Ce que les sondes attendent d'un client Hermes, injectable dans les tests. */
export type RuntimeProbeClient = Pick<HermesClient, "probe" | "toolsets" | "hostCapabilities"> & Partial<Pick<HermesClient, "health" | "capabilities">>;

/**
 * La même sonde sur un client déjà construit, direct ou relais du lien
 * connecteur. Une sonde (`/health` + `/v1/capabilities` + contrat toolsets)
 * précède toute écriture, à l'enrôlement comme à l'activation.
 */
export async function probeRuntimeCapacityWith(client: RuntimeProbeClient): Promise<number> {
  const probe = await probeRuntimeWith(client);
  return runtimeCapacity(probe.capabilities);
}

export async function probeRuntimeWith(client: RuntimeProbeClient): Promise<{ health: unknown; capabilities: unknown }> {
  try {
    const probe = await client.probe();
    await assertRuntimeToolsetContract(client);
    return probe;
  } catch (error) {
    throw mapHermesError(error);
  }
}

export async function assertRuntimeToolsetContract(client: RuntimeProbeClient): Promise<void> {
  const violation = runtimeToolsetContractViolation(await client.toolsets());
  if (!violation) return;
  throw new HttpError(409, violation.code, runtimeToolsetContractMessage(violation));
}

export function runtimeCapacity(capabilities: unknown): number {
  if (!capabilities || typeof capabilities !== "object") return 4;
  const body = capabilities as { max_concurrent_runs?: unknown; features?: Record<string, unknown> };
  const candidate = body.max_concurrent_runs ?? body.features?.max_concurrent_runs;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(1, Math.min(4, Math.floor(candidate)))
    : 4;
}

export function mapHermesError(error: unknown): HttpError {
  if (error instanceof HermesClientError) {
    // Le corps upstream peut contenir un token, un identifiant tenant ou du
    // contenu privé. Seule sa référence déterministe est sûre à journaliser.
    if (error.reference) {
      logger.error(
        { event: "api.hermes_upstream_error", code: error.code, status: error.status, reference: error.reference },
        "hermes upstream error",
      );
    }
    return new HttpError(error.status, error.code, error.message);
  }
  if (error instanceof HttpError) return error;
  return new HttpError(502, "HERMES_UNREACHABLE", "Le runtime Hermes est inaccessible.");
}
