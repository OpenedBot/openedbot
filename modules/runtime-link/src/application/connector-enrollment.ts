import { createRelayTransport } from "@openedbot/hermes";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { hashCredential, randomCredential } from "@openedbot/platform-db/credential";
import { consumeRuntimeEnrollment } from "@openedbot/runtimes/application/runtime-enrollment";
import { insertConnectorRuntime } from "@openedbot/runtimes/application/runtime-link-rows";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { probeRuntimeCapacityWith } from "@openedbot/runtimes/application/runtime-probe";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import { readAllRuntimeRows } from "@openedbot/runtimes/application/runtime-rows";
import { lockRuntimeDeclarations } from "@openedbot/runtimes/application/runtime-replacement";
import { enrolledRuntimeActivation } from "./enroll-activation";
import { insertRuntimeLinkEvent } from "./link-persistence";
import type { LinkConnection } from "./broker";
import type { IssuedLink, LinkEnrollment } from "./gateway";

/**
 * L'enrôlement par le lien : sonde À TRAVERS le tuyau, puis une seule
 * transaction : insertion du runtime `connector`, ticket brûlé, organisation
 * en `external`. Le jeton de lien naît ici et ne sort que par `link.issued`.
 */
export async function enrollConnectorRuntime(
  context: { db: Db; config: ApiConfig; instanceId: string },
  connection: LinkConnection,
  enrollment: LinkEnrollment,
  signal: AbortSignal,
): Promise<IssuedLink> {
  const client = runtimeAdminClient({
    transport: createRelayTransport({
      runtimeId: `enrollment:${enrollment.id}`,
      dial: (request, requestSignal) => connection.dispatch(request, anySignal(signal, requestSignal)),
    }),
  });
  const capacity = await probeRuntimeCapacityWith(client);
  if (signal.aborted) throw new HttpError(504, "LINK_PROBE_TIMEOUT", "La sonde d'enrôlement a dépassé son délai.");

  const linkToken = randomCredential(32);
  const tokenHash = hashCredential(linkToken);
  const runtimeId = crypto.randomUUID();
  const organizationId = enrollment.organizationId;
  await withTenant(context.db, organizationId, async (tx) => {
    // Même verrou que les autres déclarations : le ticket a pu être ouvert
    // avant qu'un autre remplaçant soit déclaré.
    await lockRuntimeDeclarations(tx, organizationId);
    const existing = await readAllRuntimeRows(tx, organizationId);
    let { active, retireId } = enrolledRuntimeActivation(existing);
    if (retireId) {
      // Le WHERE rejoue la condition : un lien rouvert entre la lecture et
      // l'écriture n'est pas retiré, et le nouveau runtime reste en attente
      // de remplacement. L'ancien est RÉVOQUÉ, pas seulement désactivé : une
      // organisation n'a qu'un runtime, et un connecteur mort gardé vivant
      // devenait un second runtime que plus aucune bascule ne rattrape.
      const cleared = await tx`
        update runtimes set revoked_at = now(), is_active = false, updated_at = now()
         where organization_id = ${organizationId} and id = ${retireId}
           and is_active and reachability = 'connector' and link_connected_at is null
        returning id
      `;
      if (cleared.length === 0) active = false;
      else await insertRuntimeLinkEvent(tx, organizationId, retireId, "revoked");
    }
    // Une organisation n'a qu'un runtime : un remplaçant de plus ne s'ajoute
    // pas à celui qui attend déjà. Le rollback laisse le ticket intact.
    if (!active && existing.some((row) => !row.isActive)) {
      throw new HttpError(409, "RUNTIME_REPLACEMENT_PENDING", "Un runtime attend déjà de remplacer l’actuel : terminez ce remplacement ou retirez-le d’abord.");
    }
    // La clé device annoncée dans `hello` est enregistrée avec le runtime :
    // dès la session suivante, le jeton seul ne suffit plus.
    await insertConnectorRuntime(tx, {
      runtimeId,
      organizationId,
      name: enrollment.runtimeName,
      tokenHash,
      instanceId: context.instanceId,
      features: connection.features,
      capacity,
      active,
      devicePublicKey: connection.devicePublicKey,
    });
    // Le secret est effacé en même temps que l'enrôlement est consommé : la
    // ligne reste pour l'audit, mais plus rien ne la rouvre.
    const burned = await consumeRuntimeEnrollment(tx, { enrollmentId: enrollment.id, organizationId, runtimeId });
    if (!burned) {
      throw new HttpError(409, "ENROLLMENT_CONSUMED", "Cet enrôlement a déjà été utilisé.");
    }
    await tx`
      update organizations set runtime_mode = 'external', updated_at = now()
       where id = ${organizationId}
    `;
  });
  return { identity: { runtimeId, organizationId, tokenHash, expiresAt: null }, linkToken };
}

function anySignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary;
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason);
  if (primary.aborted) controller.abort(primary.reason);
  else primary.addEventListener("abort", forward(primary), { once: true });
  if (secondary.aborted) controller.abort(secondary.reason);
  else secondary.addEventListener("abort", forward(secondary), { once: true });
  return controller.signal;
}
