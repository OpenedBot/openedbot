# Provenance

## D'où vient ce dépôt

`edge-setup` est la quatrième forme de l'outil qui installe et durcit un
runtime Hermes pour openedbot :

1. **2026-08, dans `openhermesbot-web`** : scripts bash + rôles Ansible
   (`scripts/hermes-runtime.sh`, `infra/ansible/roles/*`), pilotés depuis le
   poste de l'opérateur en SSH, namespace disque `openhermesbot-*`.
2. **2026-08-31, extraction dans ce dépôt** : même code, namespace `hermes-*`
   (table ci-dessous), trois scripts de migration pour l'hôte déjà provisionné.
3. **2026-09-01, réécriture en Go** (branche `raz/go-rewrite`) : un binaire
   statique exécuté **sur l'hôte**, sans Ansible ni SSH sortant, avec un mode
   `connector` qui rend le homelab possible. L'ancien arbre reste lisible via
   `git show develop:<chemin>`. Nommé `hermes-setup`.
4. **OHB-87, renommage en `edge-setup`** : même binaire, même namespace
   disque et mêmes routes de lien ; seul le fichier installé et ses copies
   PATH changent de nom, `hermes-setup` restant un alias symlink créé et
   rafraîchi par `install` et `upgrade` pour un hôte déjà provisionné.

## Ce qui a été porté verbatim

| Connaissance | Ancien emplacement (`git show develop:…`) | Nouveau |
|---|---|---|
| Épingles (Hermes, uv, Python, Docker, images) | `infra/ansible/roles/*/defaults/main.yml` | `internal/pins` + `pins_test.go` |
| Unités, drop-ins, jail, sudoers, pwquality | `roles/*/templates/*.j2` | `internal/render/templates` + `test/golden/render` |
| Transaction anti-lockout (marqueurs, flock, timer 600 s, guard) | `roles/hermes_host_hardening/templates/{guarded-exec,commit-access,rollback-access}.sh.j2`, `tasks/prepare-arm.yml` | `internal/guard`, `internal/hardening/rollback.go` |
| prepare / enforce / finalize | `roles/hermes_host_hardening/tasks/*.yml` | `internal/hardening` |
| Installation Hermes (installeur sha256, checkout, uv.lock, venv sans privilège) | `roles/hermes/tasks/main.yml` | `internal/hermes` |
| Docker rootless, délégation cgroup, mesure des limites | `roles/docker/tasks/main.yml` | `internal/docker` |
| Sandbox, contrat `platform_toolsets.api_server`, isolation loopback | `roles/hermes_sandbox/tasks/main.yml` | `internal/sandbox` |
| Audit | `scripts/lib/vps-audit.sh` (nuver-labs, MIT, `assets/NOTICE-vps-audit`) | `internal/audit` |
| Clé fournisseur par stdin, preuve `/api/model/options` | `archive/tailnet-wip:scripts/hermes-runtime.sh` `add_provider_credential` | `credentials` |

## Ce qui a été abandonné

- **`--tailnet`** (branche `archive/tailnet-wip`) : ne concernait que l'accès
  opérateur SSH, pas le lien openedbot ↔ gateway ; la clé de nœud expirante est un
  verrouillage différé. Voir `HISTORY-tailnet.md`.
- **L'exécution depuis un poste** : plus de `ssh`, de ControlMaster, ni de
  `.data/` local. La preuve « une session SSH fraîche fonctionne » est faite
  par `verify-access`, exécuté dans cette session.
- **Les scripts de migration `migrate-openhermesbot-*`** : remplacés par
  `reset --legacy` (purge) puis `up` (réinstallation).

## Namespace `openhermesbot-*` → `hermes-*`

Relevé sur l'hôte de référence lors de l'extraction ; c'est la liste que
`reset --legacy` purge.

| Ancien | Nouveau |
|---|---|
| `/etc/ssh/sshd_config.d/00-openhermesbot-hardening.conf` | `00-hermes-hardening.conf` |
| `/etc/security/pwquality.conf.d/90-openhermesbot-hardening.conf` | `90-hermes-hardening.conf` |
| `/etc/systemd/resolved.conf.d/90-openhermesbot-hardening.conf` | `90-hermes-hardening.conf` |
| `/etc/apt/apt.conf.d/52-openhermesbot-unattended` | `52-hermes-unattended` |
| `/etc/sudoers.d/81-openhermesbot-logging` | `81-hermes-logging` |
| `/etc/logrotate.d/openhermesbot-sudo` | `hermes-sudo` |
| `openhermesbot-hardening-rollback.{service,timer}` | `hermes-hardening-rollback.*` |
| `/var/lib/openhermesbot-host-hardening/` | `/var/lib/hermes-host-hardening/` |
| `/var/lib/openhermesbot/audit` | `/var/lib/hermes/audit` |
| `/var/lib/openhermesbot-runtime/` | `/var/lib/hermes-runtime/` |
| `/var/backups/openhermesbot-access` | `/var/backups/hermes-access` |
| `/var/cache/openhermesbot/uv` | `/var/cache/hermes/uv` |
| `/usr/local/lib/openhermesbot-{uv,bootstrap}` | `/usr/local/lib/hermes-{uv,bootstrap}` |
| `/usr/local/share/openhermesbot-python` | `/usr/local/share/hermes-python` |
| `/etc/openhermesbot/` | `/etc/hermes/` |
| conteneur `openhermesbot-hermes` | aucun (plus de conteneur) |

Inchangés depuis l'origine, et toujours portés par un hôte provisionné :
`/srv/hermes/data`, `/usr/local/lib/hermes-agent`, uid `hermes`,
`127.0.0.1:8642`, `hermes-gateway.service` et les commentaires UFW
`Hermes-managed`.

## Ce que la réécriture a ajouté

- `/etc/hermes/hermes-setup.json` (état non secret), `/var/lib/hermes-setup/`
  (verrou, journal), `/usr/local/lib/hermes-setup/edge-setup` (copie
  exécutée par les unités ; `hermes-setup` y reste un alias symlink).
- `hermes-connector.service`, sous l'unique uid `hermes` avec confinement
  systemd, `/etc/hermes/connector/link.json`, `/var/lib/hermes-connector/runs/`.
- `verify-access`, `reset`, `export`, audit natif avec `SKIP`, options positives
  de durcissement et sandbox opt-in.
