-- Plan 0005, delivery 1: product feature flags switch per environment.
--
-- Each flag gets two switches, `dev` and `prod`. The API reads `dev` only when
-- OPENEDBOT_ENV=development, `prod` otherwise; in production the audience then
-- applies, and it is now `off`, `staff` or `all`: the access tiers (`alpha`,
-- `beta`, `classic`) are gone, so an `alpha` or `beta` audience becomes
-- `staff`, the most restrictive one left.
--
-- ADDITIVE: `enabled` stays (the backoffice of the previous version still
-- writes it during the deploy window, and 0116's trigger keeps mirroring it);
-- migration 0180 drops it once nothing reads it.
--
-- Both switches start from what the row means today (its audience, which
-- 0116 made authoritative). `agency_workspaces` is on in development: the
-- boot seed (`initializeProductFeatures`) did that before, it no longer
-- exists. A production database ignores `dev`, a development one `prod`.
begin;

alter table product_features
  add column if not exists dev boolean,
  add column if not exists prod boolean;

update product_features
   set dev = coalesce(dev, audience <> 'off'),
       prod = coalesce(prod, audience <> 'off');

update product_features
   set audience = 'staff', updated_at = now()
 where audience in ('alpha', 'beta');

update product_features
   set dev = true
 where feature_key = 'agency_workspaces';

alter table product_features
  alter column dev set default false,
  alter column dev set not null,
  alter column prod set default false,
  alter column prod set not null;

-- Deploy window: the previous backoffice still writes `enabled`/`audience`
-- only. Such a write moves `prod` the way it moved the feature before
-- (0116: on unless the audience is `off`). Writers of plan 0005 (the new
-- backoffice) mark their transaction with `openedbot.product_flags_v2 = on`
-- and keep their explicit `dev`/`prod`. BEFORE triggers fire by name, so
-- 0116's `product_features_sync_audience` has already settled `audience`.
-- Migration 0180 drops this trigger with `enabled`.
create function sync_legacy_product_feature_switch() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('openedbot.product_flags_v2', true), '') = 'on' then
    return NEW;
  end if;
  if TG_OP = 'INSERT' or NEW.audience is distinct from OLD.audience or NEW.enabled is distinct from OLD.enabled then
    NEW.prod := NEW.audience <> 'off';
  end if;
  return NEW;
end;
$$;
create trigger product_features_sync_legacy_switch before insert or update on product_features
  for each row execute function sync_legacy_product_feature_switch();

insert into schema_migrations(version) values ('0179_product_feature_environments')
on conflict (version) do nothing;
commit;
