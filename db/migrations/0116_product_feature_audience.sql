begin;

alter table product_features add column audience text;
update product_features set audience = case when enabled then 'all' else 'off' end;
alter table product_features alter column audience set not null;
alter table product_features add constraint product_features_audience_check
  check (audience in ('off', 'staff', 'alpha', 'beta', 'all'));
alter table product_features add constraint product_features_waitlist_global_check
  check (feature_key <> 'waitlist' or audience in ('off', 'all'));

-- Keep legacy boolean writers and the audience representation consistent.
create function sync_product_feature_audience() returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    NEW.audience := coalesce(NEW.audience, case when NEW.enabled then 'all' else 'off' end);
  elsif NEW.audience = OLD.audience and NEW.enabled is distinct from OLD.enabled then
    NEW.audience := case when NEW.enabled then 'all' else 'off' end;
  end if;
  NEW.enabled := NEW.audience <> 'off';
  return NEW;
end;
$$;
create trigger product_features_sync_audience before insert or update on product_features
  for each row execute function sync_product_feature_audience();

insert into schema_migrations(version) values ('0116_product_feature_audience')
on conflict (version) do nothing;
commit;
