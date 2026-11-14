/**
 * Plan 0005, against a disposable PostgreSQL database migrated from scratch:
 * product flags switch per environment (0179) and carry nothing else (0180),
 * and signup is open to anyone, without any tier. The erasure itself, on a
 * database that still holds a waitlist, is `waitlist-erasure.ts`.
 */
import type { Db } from "@openedbot/platform-db";
import { readProductFeatures, readResolvedProductFeatures } from "../../modules/identity/src/application/product-features";
import { requestEmailLoginCode, verifyEmailLoginCode } from "../../modules/identity/src/application/email-login-code";
import { withDisposablePostgres } from "./disposable-postgres";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await withDisposablePostgres("openedbot0005_open_signup", async ({ owner, connect }) => {
  const api = await connect("openedbot_api");
  const db = api as unknown as Db;

  // 1. A blank database: every flag has both switches, no tier audience.
  const flags = await owner<Array<{ key: string; dev: boolean; prod: boolean; audience: string }>>`
    select feature_key as key, dev, prod, audience from product_features order by feature_key`;
  const flag = (key: string) => flags.find((row) => row.key === key);
  const connectorOnly = flag("connector_only_enrollment");
  assert(connectorOnly !== undefined, `connector_only_enrollment should exist on a blank database: ${JSON.stringify(flags)}`);
  assert(flags.every((row) => row.audience === "off" || row.audience === "staff" || row.audience === "all"),
    `an access-tier audience survived: ${JSON.stringify(flags)}`);
  const nullable = await owner<Array<{ column: string; nullable: string }>>`
    select column_name as column, is_nullable as nullable from information_schema.columns
     where table_name = 'product_features' and column_name in ('dev', 'prod')`;
  assert(nullable.length === 2 && nullable.every((row) => row.nullable === "NO"), `dev/prod must be not null: ${JSON.stringify(nullable)}`);

  // 2. The API role reads the switch of its environment.
  await owner`update product_features set dev = true, prod = false, audience = 'all' where feature_key = 'connector_only_enrollment'`;
  assert((await readProductFeatures(db, {}, "dev")).connectorOnlyEnrollment === true, "development reads the dev switch");
  assert((await readProductFeatures(db, {}, "prod")).connectorOnlyEnrollment === false, "production reads the prod switch");
  await owner`update product_features set prod = true, audience = 'staff' where feature_key = 'connector_only_enrollment'`;
  assert((await readProductFeatures(db, {}, "prod")).connectorOnlyEnrollment === false, "a staff audience hides the flag from a plain session");
  assert((await readResolvedProductFeatures(db, { assistedBy: "staff-1" }, "prod")).connector_only_enrollment === true,
    "a staff audience shows the flag to an impersonated session");

  // 2b. The legacy columns and their mirror triggers are gone (0180): a flag
  // is its two switches and its audience, a flag nobody configured is off, and
  // a tier audience is refused.
  const columns = await owner<Array<{ name: string }>>`
    select column_name as name from information_schema.columns where table_name = 'product_features' order by column_name`;
  assert(JSON.stringify(columns.map((column) => column.name)) === JSON.stringify(["audience", "dev", "feature_key", "prod", "updated_at"]),
    `product_features kept a legacy column: ${JSON.stringify(columns)}`);
  const triggers = await owner`select tgname from pg_trigger where tgrelid = 'product_features'::regclass and not tgisinternal`;
  assert(triggers.length === 0, `a legacy trigger survived on product_features: ${JSON.stringify(triggers)}`);
  await owner`insert into product_features (feature_key) values ('unconfigured')`;
  const [unconfigured] = await owner<Array<{ dev: boolean; prod: boolean; audience: string }>>`
    select dev, prod, audience from product_features where feature_key = 'unconfigured'`;
  assert(unconfigured?.dev === false && unconfigured.prod === false && unconfigured.audience === "off", `an unconfigured flag is not off: ${JSON.stringify(unconfigured)}`);
  let tierRefused = false;
  try { await owner`update product_features set audience = 'alpha' where feature_key = 'unconfigured'`; } catch { tierRefused = true; }
  assert(tierRefused, "a tier audience was accepted");
  assert(!flags.some((row) => row.key === "waitlist"), "the waitlist flag survived");

  // 3. Signup is open to an address nobody knows, and the account has no tier
  // to carry: the column and the waitlist table are gone.
  const email = "stranger@open-signup.test";
  await requestEmailLoginCode(db, { email, locale: "fr" });
  const [queued] = await owner<Array<{ payload: { code: string } }>>`
    select payload from email_outbox where recipient_email = ${email} order by created_at desc limit 1`;
  assert(queued?.payload.code, `no sign-in code was queued for ${email}`);
  const account = await verifyEmailLoginCode(db, { email, code: queued.payload.code });
  assert(account.user.email === email && account.organizationId === null, `signup refused for ${email}: ${JSON.stringify(account)}`);
  const tier = await owner`select 1 from information_schema.columns where table_name = 'users' and column_name = 'access_tier'`;
  assert(tier.length === 0, "users.access_tier survived");
  const [table] = await owner<Array<{ name: string | null }>>`select to_regclass('waitlist_signups')::text as name`;
  assert(table?.name === null, "the waitlist table survived");

  console.log("0005 PostgreSQL proof passed: per-environment flags, no legacy flag column, open signup without tier.");
});
