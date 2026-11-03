# Note historique : le mode `--tailnet`

Implémenté puis abandonné le 2026-09-01 (branche `archive/tailnet-wip`).

## Ce que c'était

`bootstrap --tailnet` joignait l'hôte à un tailnet Tailscale (`.deb` épinglé
par SHA-256, `tailscale up --ssh=false`), prouvait la session admin **par le
tailnet pendant que TCP/22 était encore public**, puis retirait la règle
publique : SSH n'était plus autorisé que sur `tailscale0`.

## Pourquoi c'est abandonné

- Il ne concernait que l'accès **opérateur** à l'hôte. Le lien
  OpenHermesBot ↔ gateway ne peut pas passer par un tailnet : le garde anti-SSRF
  d'OpenHermesBot refuse le CGNAT `100.64/10`, à raison en SaaS multi-tenant.
- La clé de nœud Tailscale expire (180 jours par défaut). Sur un hôte dont le
  seul accès est le tailnet, c'est un verrouillage différé. La parade (nœud
  tagué, ou expiration désactivée dans la console) déplace la sécurité dans un
  plan de contrôle tiers.
- Un second modèle d'autorisation (ACL tailnet) à côté de sshd, pour un seul
  opérateur, ne vaut pas la surface ajoutée (`tailscaled` en root, 6 advisories
  sur 12 mois dont 3 High pour Tailscale SSH).

## Ce qui reste vrai et a été gardé

- **Une preuve de fermeture de port n'est valable qu'avec un contrôle
  positif** : le tailnet servait de témoin pour prouver que le port public ne
  répondait plus. Aujourd'hui `verify-access` prouve l'accès *depuis la nouvelle
  session* et le rollback restaure UFW depuis ses sauvegardes sans dépendre
  d'aucun overlay.
- **Le rollback ne doit dépendre d'aucun réseau tiers** : invariant conservé
  (`internal/hardening/rollback.go` ne connaît que marqueurs et sauvegardes).
- Le mode `connector` répond au besoin réel (joignabilité sans port entrant),
  pour le lien openedbot et pas pour l'opérateur.

## Ce que `reset --legacy` purge

`tailscaled.service`, le paquet `tailscale`, les règles UFW `41641/udp` et
`in on tailscale0`, `/run/hermes-tailnet`.
