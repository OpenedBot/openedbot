/** Real SQL proof that a registered device key is never replaced through the link.
 * The gateway refuses a different key before any challenge; this is the second
 * lock: two concurrent first-key sessions cannot overwrite each other either.
 * The sequential cases run in one rolled-back transaction; the race uses two
 * real connections on the disposable database, which the helper drops.
 */
import { withDisposablePostgres } from "./disposable-postgres";
import { registerLinkDevicePublicKey } from "../../modules/runtimes/src/sql/runtime-link-rows";

await withDisposablePostgres("openedbot50_device_key", async ({ owner: db, connect }) => {
  const organizationId = crypto.randomUUID(), runtimeId = crypto.randomUUID();
  const tokenHash = "device-key-current-hash";
  const keyA = Buffer.alloc(32, 1).toString("base64"), keyB = Buffer.alloc(32, 2).toString("base64");
  const rollback = new Error("ROLLBACK_DEVICE_KEY_FIXTURES");
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  try {
    await db.begin(async (tx) => {
      await tx`insert into organizations (id, slug, name) values (${organizationId}, ${`device-key-${organizationId}`}, 'Device key test fixture')`;
      await tx`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active)
        values (${runtimeId}, ${organizationId}, 'Device key fixture', 'connector', ${tokenHash}, false)`;
      const scope = { runtimeId, organizationId, tokenHash };
      const register = async (key: string, hash = tokenHash) => {
        await tx`set local role openedbot_api`;
        await tx`select set_config('app.session_credential_hash', ${hash}, true)`;
        const stored = await registerLinkDevicePublicKey(tx, { ...scope, tokenHash: hash }, key);
        await tx`reset role`;
        return stored;
      };
      const storedKey = async () => (await tx`select link_device_pubkey as key from runtimes where id = ${runtimeId}`)[0].key as string | null;

      assert(await register(keyA), "first key under the current token was not registered");
      assert((await storedKey()) === keyA, "first key was not persisted");
      // The same host coming up twice at once registers the same key: still accepted.
      assert(await register(keyA), "re-registering the same key was refused");
      // A second first-key session that lost the race must not overwrite the winner.
      assert(!(await register(keyB)), "a different key replaced the registered one");
      assert((await storedKey()) === keyA, "registered key changed");
      // A wrong token never writes, even on a runtime without a key.
      await tx`update runtimes set link_device_pubkey = null where id = ${runtimeId}`;
      assert(!(await register(keyB, "device-key-wrong-hash")), "a wrong token registered a key");
      assert((await storedKey()) === null, "a wrong token wrote the key");
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  const remaining = await db`select id from organizations where id = ${organizationId}`;
  assert(remaining.length === 0, "device key fixtures were not rolled back");

  // Two first-key sessions at once, each on its own connection: A updates and
  // holds its row lock, B blocks on it; once A commits, B re-reads the row
  // under READ COMMITTED, sees A's key, and must write nothing.
  const raceRuntimeId = crypto.randomUUID();
  await db`insert into organizations (id, slug, name) values (${organizationId}, ${`device-key-race-${organizationId}`}, 'Device key race fixture')`;
  await db`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active)
    values (${raceRuntimeId}, ${organizationId}, 'Device key race fixture', 'connector', ${tokenHash}, false)`;
  const raceScope = { runtimeId: raceRuntimeId, organizationId, tokenHash };
  const [first, second] = [await connect("openedbot_api"), await connect("openedbot_api")];
  let releaseFirst!: () => void;
  const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstUpdated!: () => void;
  const firstWrote = new Promise<void>((resolve) => { firstUpdated = resolve; });
  const firstRun = first.begin(async (tx) => {
    await tx`select set_config('app.session_credential_hash', ${tokenHash}, true)`;
    const stored = await registerLinkDevicePublicKey(tx, raceScope, keyA);
    firstUpdated();
    await firstHolds;
    return stored;
  });
  await firstWrote;
  const secondRun = second.begin(async (tx) => {
    await tx`select set_config('app.session_credential_hash', ${tokenHash}, true)`;
    return registerLinkDevicePublicKey(tx, raceScope, keyB);
  });
  const whileHeld = await Promise.race([secondRun.then(() => "finished"), Bun.sleep(300).then(() => "blocked")]);
  assert(whileHeld === "blocked", "the second registration did not wait for the first one's row lock");
  releaseFirst();
  const [firstStored, secondStored] = await Promise.all([firstRun, secondRun]);
  assert(firstStored === true && secondStored === false, `race outcome first=${firstStored} second=${secondStored}`);
  const raced = await db`select link_device_pubkey as key from runtimes where id = ${raceRuntimeId}`;
  assert(raced[0].key === keyA, "the losing registration overwrote the winner");
  console.info(JSON.stringify({ test: "runtime-link-device-key-real-db", passed: true, fixturesRolledBack: true, concurrentRace: true }));
});
