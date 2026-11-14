import { strict as assert } from "node:assert";
import { hashCredential, randomCredential } from "@openedbot/platform-db/credential";
import { refreshNativeSession } from "../../modules/identity/src/application/native-auth";
import { attachSessionOrganization, createNativeSession, revokeUserSession } from "../../modules/identity/src/sql/sessions";
import { withDisposablePostgres } from "./disposable-postgres";

const USER = "91860000-0000-4000-8000-000000000001";
const ORG = "91860000-0000-4000-8000-000000000002";
const device = { userAgent: "openedbot/recovery-test", ip: "127.0.0.1" };

await withDisposablePostgres("openedbot186_native_refresh", async ({ owner, connect }) => {
  await owner`insert into users (id, email) values (${USER}, 'native-recovery@example.test')`;
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'native-recovery', 'Recovery')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
  const api = await connect("openedbot_api");
  const api2 = await connect("openedbot_api");
  const refused = (promise: Promise<unknown>) => assert.rejects(promise, { status: 401, code: "REFRESH_TOKEN_INVALID" });
  for (const organization of [null, ORG]) {
    const original = await createNativeSession(api, organization, USER, device);
    const attempt = randomCredential();
    // Commit completed; the client sees a transport failure instead of this response.
    const committed = await refreshNativeSession(api, original.refreshToken, device, attempt);
    const recovered = await refreshNativeSession(api, original.refreshToken, device, attempt);
    assert.deepEqual(recovered, committed, "lost response reconstructs exactly the committed tokens");
    await refused(refreshNativeSession(api, original.refreshToken, device, randomCredential()));
    await refused(refreshNativeSession(api, original.refreshToken, device));
    const [row] = await owner<Array<{ id: string; familyId: string; deadline: Date }>>`
      select id, family_id as "familyId", refresh_recovery_until as deadline from sessions
       where refresh_token_hash = ${hashCredential(original.refreshToken)}
    `;
    assert(row);
    const [successor] = await owner<Array<{ id: string; familyId: string }>>`
      select id, family_id as "familyId" from sessions where access_token_hash = ${hashCredential(committed.accessToken)}
    `;
    assert(successor);
    assert.equal(successor.familyId, row.familyId);
    if (organization === null) {
      await attachSessionOrganization(api, hashCredential(committed.accessToken), successor.id, ORG);
      assert.equal((await refreshNativeSession(api, original.refreshToken, device, attempt)).organizationId, ORG);
    }
    const [after] = await owner<Array<{ deadline: Date }>>`select refresh_recovery_until as deadline from sessions where id = ${row.id}`;
    assert.equal(after?.deadline.getTime(), row.deadline.getTime(), "retries do not extend the window");
    await revokeUserSession(api, USER, row.id);
    await refused(refreshNativeSession(api, original.refreshToken, device, attempt));
    await refused(refreshNativeSession(api, committed.refreshToken, device, randomCredential()));
  }
  const original = await createNativeSession(api, ORG, USER, device);
  const attempt = randomCredential();
  const [first, parallel] = await Promise.all([
    refreshNativeSession(api, original.refreshToken, device, attempt),
    refreshNativeSession(api2, original.refreshToken, device, attempt),
  ]);
  assert.deepEqual(first, parallel, "parallel delivery of one attempt has one successor");
  await refreshNativeSession(api, first.refreshToken, device, randomCredential());
  await refused(refreshNativeSession(api, original.refreshToken, device, attempt));

  const expired = await createNativeSession(api, ORG, USER, device);
  const expiredAttempt = randomCredential();
  await refreshNativeSession(api, expired.refreshToken, device, expiredAttempt);
  await owner`update sessions set refresh_recovery_until = clock_timestamp() - interval '1 second'
    where refresh_token_hash = ${hashCredential(expired.refreshToken)}`;
  await refused(refreshNativeSession(api, expired.refreshToken, device, expiredAttempt));

  const legacy = await createNativeSession(api, ORG, USER, device);
  await refreshNativeSession(api, legacy.refreshToken, device);
  await refused(refreshNativeSession(api, legacy.refreshToken, device));
  console.log("PASS native refresh recovery: real API-role RLS, lost response, concurrency, expiry, legacy, onboarding and revocation");
});
