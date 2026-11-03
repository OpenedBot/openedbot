import "@openedbot/platform-config/legacy-env-guard"; // first: refuses a retired OHB_* variable before any module reads the environment
import { SQL } from "bun";
import { isProductionEnvironment } from "@openedbot/platform-config/deploy-environment";
import { encryptSecret } from "@openedbot/hermes/secrets";
import { resolve } from "node:path";
import {
  DEV_SEED_EMAIL,
  DEV_STAFF_EMAIL,
  readApiConfig,
} from "../src/infrastructure/config";
import { devEnvFilePath, ensureDevPasswords } from "./dev-passwords";
import { seedDefaultSection } from "./seed-sections";
import { withAuthenticatingUser, withTenant } from "@openedbot/platform-db";
import { HermesClient } from "@openedbot/hermes";
import { runtimeToolsetContractMessage, runtimeToolsetContractViolation } from "@openedbot/runtimes/domain/runtime-contract";
import { initializeProductFeatures, isExplicitDevelopmentEnvironment } from "@openedbot/identity/application/product-features";

if (isProductionEnvironment(process.env.OPENEDBOT_ENV ?? process.env.NODE_ENV)) throw new Error("Development seed is forbidden in production.");
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
const staffUserId = "00000000-0000-4000-8000-000000000501";
const organizationId = "00000000-0000-4000-8000-000000000201";
const sectionId = "00000000-0000-4000-8000-000000000301";
const runtimeId = "00000000-0000-4000-8000-000000000401";
// Les mêmes valeurs que `config.devSignIn` publie à `/login` : le compte semé
// et le compte pré-rempli ne peuvent pas diverger.
const email = config.devSignIn?.email ?? (process.env.E2E_EMAIL?.trim() || DEV_SEED_EMAIL);
const password = config.devSignIn?.password ?? process.env.E2E_PASSWORD!;
const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
const staffEmail = (process.env.DEV_STAFF_EMAIL?.trim() || DEV_STAFF_EMAIL).toLowerCase();
const staffPassword = process.env.DEV_STAFF_PASSWORD!;
const staffPasswordHash = await Bun.password.hash(staffPassword, { algorithm: "argon2id" });
const token = process.env.DEV_HERMES_TOKEN?.trim() || null;
// The hardcoded dev runtime row only belongs to the fake profile: the fake
// gateway needs a pre-registered runtime to answer. External hosts register
// theirs through the application (enrollment or the runtime form), so seeding
// one here would shadow the real registration path.
// `OPENEDBOT_DEV_PROFILE` is exported by the Makefile (`make db-seed`).
const devProfile = process.env.OPENEDBOT_DEV_PROFILE?.trim() ?? "";
const seedRuntimeRow = devProfile === "fake";
let runtimeReadiness: { providerReady: boolean } | null = null;
/** Vrai seulement si la ligne du faux Hermes a réellement été écrite. */
let runtimeRowSeeded = false;

try {
  await initializeProductFeatures(db, isExplicitDevelopmentEnvironment());
  if (seedRuntimeRow && token && config.developmentHermesUrl) {
    const client = new HermesClient({
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
    // `personal_owner_user_id` n'est pas posé ici : 0086 le renseigne pour une
    // organisation à owner unique, et le forcer ferait échouer le seed d'un
    // poste où l'owner a déjà créé une autre organisation personnelle.
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
    // Dette datée (jusqu'au 2026-12-31, db/ownership.json) : la table
    // `subscriptions` reste au cœur ; solo ne la lit pas (NO_SUBSCRIPTIONS),
    // le plug-in billing la lit en pro. Le seed y pose l'abonnement de dev
    // tant qu'aucun hook de seed de plug-in n'existe.
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
      // Le runtime ACTIF de l'organisation de développement, s'il y en a un.
      // Cette lecture est ce qui protège un lien réel : quand un connecteur est
      // déjà appairé sur ce poste (`make link-dev-up`), la ligne active est la
      // SIENNE, en `reachability = 'connector'` et sans endpoint. L'écraser
      // avec le faux Hermes débrancherait un runtime qui fonctionne, et la
      // contrainte de forme (`runtimes_reachability_shape_check`, 0024) refuse
      // de toute façon un endpoint et un jeton sur une ligne connecteur : le
      // seed entier échouait là, avant d'avoir semé quoi que ce soit d'autre.
      //
      // Le conflit n'est pas non plus celui qu'on croyait : `on conflict
      // (organization_id) where is_active` ne couvre pas la clé primaire, et la
      // ligne du faux Hermes SURVIT à une désactivation. Un second seed la
      // retrouvait donc en doublon d'identifiant.
      const activeRuntime = await tx<Array<{ id: string }>>`
        select id from runtimes where organization_id = ${organizationId} and is_active limit 1
      `;
      const held = activeRuntime[0] && activeRuntime[0].id !== runtimeId;
      if (held) {
        // Dit, jamais tu : le profil fake n'a pas son runtime, et c'est un
        // choix, pas une panne silencieuse.
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
  // Dated debt (until 2026-12-31): staff_users lives in the core migrations
  // while the back office is a pro module, so the dev staff account is seeded
  // here with the one GUC its RLS policy reads, set inline.
  await db.begin(async (tx) => {
    await tx`select set_config('app.staff_user_id', ${staffUserId}, true)`;
    await tx`
      insert into staff_users (id, email, password_hash, display_name)
      values (${staffUserId}, ${staffEmail}, ${staffPasswordHash}, 'Staff Dev')
      on conflict (id) do update set email = excluded.email, password_hash = excluded.password_hash,
        display_name = excluded.display_name, disabled_at = null, updated_at = now()
    `;
  });
  // --- Liste d'attente de développement --------------------------------------
  //
  // Dix inscriptions EN ATTENTE, pour que `/waitlist` du backoffice ait de quoi
  // montrer : la table, la recherche, le filtre d'état et surtout les deux
  // gestes qui ouvrent la porte du produit (valider avec un mode, retirer).
  // Aucune n'est validée d'avance : c'est précisément la validation qu'on vient
  // essayer, et une base semée à moitié ouverte mentirait sur l'état de départ.
  //
  // Identifiants et dates DÉTERMINISTES : rejouer `make db-seed` retrouve les
  // mêmes lignes, dans le même ordre, plutôt que d'en empiler dix de plus.
  // Le domaine est `.test` (RFC 2606), qui ne résout nulle part : valider une
  // de ces adresses dépose bien un e-mail dans la file, et cet e-mail ne peut
  // atteindre personne.
  //
  // `on conflict (email) do nothing` NOMME sa colonne, ce que la route publique
  // ne peut pas faire (écriture seule, 0065) : le seed tourne avec un rôle qui
  // lit la table, et nommer la contrainte dit ce qui est rejoué.
  const waitlistSeed = [
    { local: "camille.roy", domain: "exemple.test", locale: "fr" },
    { local: "leo.martin", domain: "exemple.test", locale: "fr" },
    { local: "ines.dubois", domain: "atelier.test", locale: "fr" },
    { local: "noah.bernard", domain: "atelier.test", locale: "en" },
    { local: "sofia.moreau", domain: "exemple.test", locale: "en" },
    { local: "gabriel.laurent", domain: "studio.test", locale: "fr" },
    { local: "jade.fontaine", domain: "studio.test", locale: "en" },
    { local: "arthur.mercier", domain: "exemple.test", locale: null },
    { local: "louise.girard", domain: "atelier.test", locale: "fr" },
    { local: "hugo.petit", domain: "studio.test", locale: "en" },
  ];
  let waitlistSeeded = 0;
  for (const [index, entry] of waitlistSeed.entries()) {
    // L'identifiant dérive du rang : la deuxième passe retombe sur la même
    // ligne même si l'adresse a été retirée depuis la première.
    const id = `00000000-0000-4000-8000-0000000006${String(index + 1).padStart(2, "0")}`;
    const written = await db`
      insert into waitlist_signups (id, email, locale, created_at)
      values (
        ${id},
        ${`${entry.local}@${entry.domain}`},
        ${entry.locale},
        now() - make_interval(hours => ${(index + 1) * 7})
      )
      on conflict (email) do nothing
    `;
    waitlistSeeded += written.count;
  }

  console.info(JSON.stringify({
    event: "db.seeded",
    email,
    staffEmail,
    organizationId,
    runtimeMode: config.runtimeMode,
    runtimeSeeded: runtimeRowSeeded,
    runtimeCompatible: Boolean(runtimeReadiness),
    providerReady: runtimeReadiness?.providerReady ?? false,
    onboardingCompleted: false,
    // Ce que CETTE passe a écrit : zéro sur une base déjà semée, les dix
    // inscriptions étant alors déjà là.
    waitlistSignupsInserted: waitlistSeeded,
    waitlistSignupsSeeded: waitlistSeed.length,
  }));
} finally {
  await db.close();
}
