/**
 * Seeds the disposable `openedbot_load` database for one bench run: LOAD_ORGANIZATIONS
 * organizations, each with its owner, an active subscription, one direct
 * runtime pointed at the fake Hermes, LOAD_BOTS_PER_ORGANIZATION bots with one
 * thread each, and enough native sessions to reach the LOAD_SESSIONS tier.
 *
 * The runtime bearer is encrypted with the same RUNTIME_TOKEN_ENCRYPTION_KEY the
 * API and the workers receive from run.sh, under the key id they will look up.
 * Refuses any database that is not exactly `openedbot_load`.
 */
import { createHash, randomBytes } from "node:crypto";
import { SQL } from "bun";
import { encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/secrets";
import { readTier, type LoadManifest, type LoadSession } from "./lib/manifest";

const databaseUrl = process.env.LOAD_DATABASE_URL?.trim();
const manifestPath = process.env.LOAD_MANIFEST?.trim();
const endpoint = process.env.LOAD_HERMES_URL?.trim();
const token = process.env.LOAD_HERMES_TOKEN?.trim();
const encryptionKey = process.env.RUNTIME_TOKEN_ENCRYPTION_KEY?.trim();
const tier = readTier(process.env.LOAD_SESSIONS);
const organizations = Number(process.env.LOAD_ORGANIZATIONS ?? 50);
const botsPerOrganization = Number(process.env.LOAD_BOTS_PER_ORGANIZATION ?? 4);

if (!databaseUrl || new URL(databaseUrl).pathname !== "/openedbot_load") {
  throw new Error("LOAD_DATABASE_URL must target the exact openedbot_load database.");
}
if (!manifestPath) throw new Error("LOAD_MANIFEST is required.");
if (!endpoint || !token) throw new Error("LOAD_HERMES_URL and LOAD_HERMES_TOKEN are required.");
if (!encryptionKey) throw new Error("RUNTIME_TOKEN_ENCRYPTION_KEY is required.");
if (!Number.isInteger(organizations) || organizations < 1) throw new Error("LOAD_ORGANIZATIONS must be a positive integer.");
if (!Number.isInteger(botsPerOrganization) || botsPerOrganization < 1) throw new Error("LOAD_BOTS_PER_ORGANIZATION must be a positive integer.");

const key = secretEncryptionKey(Uint8Array.from(Buffer.from(encryptionKey, "base64")));
const sessionsPerOrganization = Math.ceil(tier / organizations);
const db = new SQL(databaseUrl);
const sessions: LoadSession[] = [];
try {
  for (let index = 0; index < organizations; index += 1) {
    const organizationId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    const encrypted = encryptSecret(token, key.value);
    const threadIds: string[] = [];
    await db.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${organizationId}, true)`;
      await tx`
        insert into users (id, email, display_name)
        values (${userId}, ${`load-${index}@openedbot.local`}, ${`Load ${index}`})
      `;
      await tx`
        insert into organizations (id, slug, name, kind)
        values (${organizationId}, ${`load-${index}`}, ${`Load ${index}`}, 'personal')
      `;
      await tx`insert into memberships (organization_id, user_id, role) values (${organizationId}, ${userId}, 'owner')`;
      await tx`
        insert into subscriptions (organization_id, status, runtime_limit, member_limit, concurrent_run_limit, attachment_quota_bytes)
        values (${organizationId}, 'active', 1, 2, ${botsPerOrganization}, 1073741824)
      `;
      await tx`
        insert into runtimes (
          id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
          capacity, last_health_status, last_probed_at, is_active
        ) values (
          ${crypto.randomUUID()}, ${organizationId}, 'Fake Hermes', ${endpoint}, ${encrypted.ciphertext},
          ${encrypted.nonce}, ${encrypted.tag}, ${key.id}, ${botsPerOrganization}, 'healthy', now(), true
        )
      `;
      await tx`insert into sections (id, organization_id, name, position) values (${sectionId}, ${organizationId}, 'Load bots', 0)`;
      for (let botIndex = 0; botIndex < botsPerOrganization; botIndex += 1) {
        const botId = crypto.randomUUID();
        const threadId = crypto.randomUUID();
        threadIds.push(threadId);
        await tx`
          insert into bots (id, organization_id, section_id, name, slug, instructions, hermes_profile, position)
          values (${botId}, ${organizationId}, ${sectionId}, ${`Bot ${botIndex}`}, ${`bot-${botIndex}`},
                  'Answer briefly.', ${`load-${index}-${botIndex}`}, ${botIndex})
        `;
        await tx`
          insert into threads (id, organization_id, bot_id, title, hermes_session_id)
          values (${threadId}, ${organizationId}, ${botId}, ${`Bot ${botIndex}`}, ${`load-${index}-${botIndex}`})
        `;
      }
      for (let sessionIndex = 0; sessionIndex < sessionsPerOrganization && sessions.length < tier; sessionIndex += 1) {
        const accessToken = randomBytes(32).toString("base64url");
        await tx`
          insert into sessions (id, organization_id, user_id, kind, access_token_hash, access_expires_at)
          values (${crypto.randomUUID()}, ${organizationId}, ${userId}, 'native', ${sha256(accessToken)}, now() + interval '4 hours')
        `;
        sessions.push({ accessToken, organizationId, threadIds });
      }
    });
  }
  const manifest: LoadManifest = { organizations, sessions };
  await Bun.write(manifestPath, JSON.stringify(manifest));
  console.info(JSON.stringify({ event: "load.seeded", organizations, botsPerOrganization, sessions: sessions.length }));
} finally {
  await db.close();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
