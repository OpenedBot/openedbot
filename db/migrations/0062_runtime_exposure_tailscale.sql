begin;

-- La publication Tailscale Funnel devient assistée, comme Cloudflare.
--
-- openedbot pose l'attribut `funnel` sur son tag dans le fichier de politique du
-- tailnet du client, puis crée une clé d'appairage taguée. Cette clé est le
-- secret de la commande à coller : elle voyage dans `install_token_*`, déjà
-- chiffré et effacé à la déclaration. Seul son identifiant est conservé, pour
-- pouvoir la révoquer. Le client OAuth du tailnet, lui, n'est jamais écrit.
alter table runtime_direct_exposures add column tailscale_auth_key_id text;

comment on column runtime_direct_exposures.tailscale_auth_key_id is
  'Identifiant de la clé d''appairage Tailscale créée pour cette publication ; la clé elle-même vit dans install_token_ciphertext.';

-- `customer_cloudflare` n'est plus produit : le parcours qui exigeait un domaine
-- Cloudflare chez le client a été retiré. La contrainte garde la valeur pour ne
-- pas rendre illisibles les publications déjà écrites, qui restent révocables.
comment on table runtime_direct_exposures is
  'Publication of a direct gateway (openedbot-managed Cloudflare, Tailscale Funnel). customer_cloudflare is legacy: readable and revocable, never created again.';

insert into schema_migrations(version) values ('0062_runtime_exposure_tailscale') on conflict (version) do nothing;

commit;
