import { SQL } from "bun";
import { readRuntimeEnvironment } from "@openedbot/platform-config/deploy-environment";
import { encryptSecret } from "@openedbot/hermes/secrets";
import { resolve } from "node:path";
import {
  DEV_SEED_EMAIL,
  readApiConfig,
} from "../src/infrastructure/config";
import { devEnvFilePath, ensureDevPasswords } from "./dev-passwords";
import { seedDefaultSection } from "./seed-sections";
import { withAuthenticatingUser, withTenant } from "@openedbot/platform-db";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import { runtimeToolsetContractMessage, runtimeToolsetContractViolation } from "@openedbot/runtimes/domain/runtime-contract";

if (readRuntimeEnvironment(process.env.OPENEDBOT_ENV ?? process.env.NODE_ENV) === "production") throw new Error("Development seed is forbidden in production.");
// No development password is versioned: a missing one is generated now and
// stored in the env file `make` loaded; only its location is printed.
const devEnvFile = devEnvFilePath(process.env, resolve(import.meta.dir, "../../.."));
for (const name of ensureDevPasswords(process.env, devEnvFile)) {
  console.log(`Generated ${name} for the seeded account; stored in ${devEnvFile} (chmod 600).`);
}

const config = readApiConfig();
if (config.environment === "production") throw new Error("Development seed is forbidden in production.");

const db = new SQL(config.databaseUrl);
const userId = "00000000-0000-4000-8000-000000000101";
const organizationId = "00000000-0000-4000-8000-000000000201";
const sectionId = "00000000-0000-4000-8000-000000000301";
const runtimeId = "00000000-0000-4000-8000-000000000401";
// The same values `config.devSignIn` publishes at `/login`: the seeded account
// and the prefilled account cannot diverge.
const email = config.devSignIn?.email ?? (process.env.E2E_EMAIL?.trim() || DEV_SEED_EMAIL);
const password = config.devSignIn?.password ?? process.env.E2E_PASSWORD!;
const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
const token = process.env.DEV_HERMES_TOKEN?.trim() || null;
// The hardcoded dev runtime row only belongs to the fake profile: the fake
// gateway needs a pre-registered runtime to answer. External hosts register
// theirs through the application (enrollment or the runtime form), so seeding
// one here would shadow the real registration path.
// `OPENEDBOT_DEV_PROFILE` is exported by the Makefile (`make db-seed`).
const devProfile = process.env.OPENEDBOT_DEV_PROFILE?.trim() ?? "";
const seedRuntimeRow = devProfile === "fake";
let runtimeReadiness: { providerReady: boolean } | null = null;
/** True only if the fake Hermes row was actually written. */
let runtimeRowSeeded = false;

try {
  if (seedRuntimeRow && token && config.developmentHermesUrl) {
    const client = runtimeAdminClient({
      endpoint: config.developmentHermesUrl,
      token,
      policy: config.hermesEndpointPolicy,
      mtls: config.hermesMtls,
    });
    await client.probe();
    const violation = runtimeToolsetContractViolation(await client.toolsets());
    if (violation) throw new Error(runtimeToolsetContractMessage(violation));
    const models = await client.modelOptions();
    runtimeReadiness = {
      providerReady: models.providers.some((provider) => provider.authenticated && provider.slug !== "moa"),
    };
  }
  await db`
    insert into users (id, email, password_hash, display_name, onboarding_completed)
    values (${userId}, ${email.toLowerCase()}, ${passwordHash}, 'Dev Owner', false)
    on conflict (id) do update set email = excluded.email, password_hash = excluded.password_hash,
      display_name = excluded.display_name, updated_at = now()
  `;
  await withTenant(db, organizationId, async (tx) => {
    // `personal_owner_user_id` is not set here: 0086 fills it in for an
    // organization with a single owner, and forcing it would fail the seed of a
    // workstation where the owner has already created another personal organization.
    await tx`
      insert into organizations (id, slug, name, kind)
      values (${organizationId}, 'dev', 'openedbot Dev', 'personal')
      on conflict (id) do update set name = excluded.name, kind = 'personal', deleted_at = null, updated_at = now()
    `;
    await tx`
      insert into memberships (organization_id, user_id, role)
      values (${organizationId}, ${userId}, 'owner')
      on conflict (organization_id, user_id) do update set role = 'owner', revoked_at = null
    `;
    // Dated debt (until 2026-12-31, db/ownership.json): the
    // `subscriptions` table stays in the core; solo does not read it (NO_SUBSCRIPTIONS),
    // the billing plug-in reads it in pro. The seed writes the dev subscription there
    // until a plug-in seed hook exists.
    await tx`
      insert into subscriptions (
        organization_id, status, runtime_limit, member_limit, concurrent_run_limit, attachment_quota_bytes
      ) values (${organizationId}, 'active', 1, 2, 4, 1073741824)
      on conflict (organization_id) do update set status = 'active', runtime_limit = 1,
        member_limit = 2, concurrent_run_limit = 4, attachment_quota_bytes = 1073741824, updated_at = now()
    `;
    await seedDefaultSection(tx, organizationId, sectionId);
    if (seedRuntimeRow && token && config.developmentHermesUrl) {
      const runtimeName = new URL(config.developmentHermesUrl).host;
      const encrypted = encryptSecret(token, config.tokenEncryption.current.value);
      // The ACTIVE runtime of the development organization, if there is one.
      // This read is what protects a real link: when a connector is
      // already paired on this workstation (`make link-dev-up`), the active row is
      // ITS OWN, with `reachability = 'connector'` and no endpoint. Overwriting it
      // with the fake Hermes would disconnect a runtime that works, and the
      // shape constraint (`runtimes_reachability_shape_check`, 0024) refuses
      // an endpoint and a token on a connector row anyway: the
      // whole seed failed there, before having seeded anything else.
      //
      // The conflict is not the one we thought either: `on conflict
      // (organization_id) where is_active` does not cover the primary key, and the
      // fake Hermes row SURVIVES a deactivation. A second seed therefore
      // found it again as a duplicate identifier.
      const activeRuntime = await tx<Array<{ id: string }>>`
        select id from runtimes where organization_id = ${organizationId} and is_active limit 1
      `;
      const held = activeRuntime[0] && activeRuntime[0].id !== runtimeId;
      if (held) {
        // Stated, never "you": the fake profile has no runtime of its own, and that is a
        // choice, not a silent failure.
        console.warn(JSON.stringify({
          event: "db.seed.runtime_skipped",
          reason: "active_runtime_belongs_to_this_workspace",
          runtimeId: activeRuntime[0]?.id,
        }));
      } else {
        await tx`
          insert into runtimes (
            id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
            capacity, last_health_status, last_probed_at, is_active
          ) values (
            ${runtimeId}, ${organizationId}, ${runtimeName}, ${config.developmentHermesUrl},
            ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.tag},
            ${config.tokenEncryption.current.id}, 4, 'healthy', now(), true
          )
          on conflict (id) do update set name = excluded.name, endpoint = excluded.endpoint,
            token_ciphertext = excluded.token_ciphertext, token_nonce = excluded.token_nonce,
            token_tag = excluded.token_tag, token_key_id = excluded.token_key_id,
            reachability = 'direct', link_token_hash = null, is_active = true,
            revoked_at = null, last_health_status = 'healthy', last_health_error = null,
            last_probed_at = now(), updated_at = now()
        `;
        runtimeRowSeeded = true;
      }
    }
  });
  console.info(JSON.stringify({
    event: "db.seeded",
    email,
    organizationId,
    runtimeMode: config.runtimeMode,
    runtimeSeeded: runtimeRowSeeded,
    runtimeCompatible: Boolean(runtimeReadiness),
    providerReady: runtimeReadiness?.providerReady ?? false,
    onboardingCompleted: false,
  }));
} finally {
  await db.close();
}
