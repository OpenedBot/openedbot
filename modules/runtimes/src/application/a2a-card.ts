import type { A2aAgentCard, A2aCardReadDto } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertClientMandate } from "./fleet";

export type A2aCardRuntime = {
  id: string;
  client: { hostCapabilities(): Promise<string[] | null>; a2aAgentCard(): Promise<A2aAgentCard> };
};

/** Network reads never keep a database transaction open; the exact mandate is rechecked afterwards. */
export async function readAgencyA2aCard(db: Db, scope: { userId: string; agencyId: string; clientId: string },
  resolveRuntime: () => Promise<A2aCardRuntime | null>): Promise<A2aCardReadDto> {
  const authorize = () => withTenant(db, scope.clientId, (tx) =>
    assertClientMandate(tx, scope.userId, scope.clientId, scope.agencyId));
  await authorize();
  let state: A2aCardReadDto["state"] = "unavailable";
  let runtimeId: string | null = null;
  let card: A2aAgentCard | null = null;
  try {
    const runtime = await resolveRuntime();
    if (!runtime) state = "no_runtime";
    else {
      runtimeId = runtime.id;
      const capabilities = await runtime.client.hostCapabilities();
      if (!capabilities?.includes("a2a_card")) state = "unsupported";
      else { card = await runtime.client.a2aAgentCard(); state = "available"; }
    }
  } catch {
    // A link failure, malformed card or failed host attestation is an unavailable read.
    state = "unavailable"; card = null;
  }
  await authorize();
  return { state, runtimeId, card, observedAt: new Date().toISOString() };
}
