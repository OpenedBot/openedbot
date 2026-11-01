# edge-setup : état des lieux de sécurité

Relevé fait le 2026-10-30 sur la branche `fix/opened-bot-release`, avant toute
modification, en lisant `edge-setup/` (binaire Go, gabarits, scripts, CI) et le
script d'amorçage servi par la documentation (`docs/public/install`). Seul le
chemin Linux est audité ; le mode macOS (`launchd`, trousseau) est hors
périmètre de ce document.

## 1. Ce qu'est edge-setup

Deux pièces :

1. **L'amorçage** `docs/public/install` (POSIX `sh`, servi sur
   `https://docs.openedbot.app/install`) : télécharge `SHA256SUMS` et
   `edge-setup_linux_<arch>` depuis `https://releases.openedbot.app/edge-setup`,
   compare le SHA-256, puis `install -m 0755` vers `/usr/local/sbin/edge-setup`
   (avec `sudo` si besoin) et exécute `edge-setup version`.
2. **Le binaire** `edge-setup` (Go statique, sans cgo) : exécuté **sur l'hôte**,
   il installe le runtime Hermes, l'appaire à la console par un lien sortant et
   applique des politiques d'hôte optionnelles.

Commandes (Linux) : `detect`, `status`, `plan`, `doctor`, `audit`, `export`
(lecture seule) ; `up`, `verify-access`, `link`, `unlink`, `credentials`,
`upgrade`, `update`, `self-verify`, `auto-upgrade`, `deploy-key`, `reset`,
`uninstall` ; `internal {connector,operator,rollback-access}` pour systemd.

Phases de `up --yes` :

| Phase | Effet |
|---|---|
| P1 self-install | copie le binaire vers `/usr/local/lib/hermes-setup/edge-setup`, liens PATH |
| P2 base | `apt-get update`, paquets système |
| P3/P5 runtime | uv épinglé (SHA-256), Python géré par uv, Node épinglé (SHA-256), installeur Hermes épinglé (commit + SHA-256), venv, unité gateway |
| P4/P6 sandbox (`--sandbox`) | Docker CE rootless (apt, versions exactes, clé GPG épinglée), images par digest |
| P7 harden (opt-in) | sshd, UFW, fail2ban, pwquality, LLMNR, unattended-upgrades, journal persistant, sudo-logging, quarantaine du compte cloud-init, sous transaction anti-lockout (minuterie de retour arrière 600 s) |
| P8 connect | unités `hermes-operator` et `hermes-connector` |
| P9 finalize | preuves et audit strict |

## 2. Fichiers écrits

Tous les écrits passent par `internal/fsx` (écriture atomique, propriétaire et
mode vérifiés à la relecture).

| Chemin | Propriétaire / mode | Contenu |
|---|---|---|
| `/usr/local/sbin/edge-setup` | root 0755 | binaire posé par l'amorçage |
| `/usr/local/lib/hermes-setup/edge-setup` (+ alias `hermes-setup`, `edge-setup.previous`) | root 0755 | binaire exécuté par les unités |
| `/usr/local/bin/edge-setup`, `hermes-setup` | lien symbolique | PATH |
| `/etc/hermes/hermes-setup.json` | root | état non secret |
| `/etc/hermes/deploy.key` | root 0600 | clé HMAC de déploiement (mode dev seulement) |
| `/etc/hermes/connector/link.json` | hermes 0600 | jeton de lien (secret) |
| `/etc/hermes/connector/device.key.cred` | root | graine Ed25519 chiffrée par `systemd-creds` |
| `/etc/hermes/connector/allowlist.json` | root | routes autorisées |
| `/var/lib/hermes-setup/` | root | verrous, marqueurs, `auto-upgrade.json`, quarantaine |
| `/var/lib/hermes-connector/` | hermes 0700 | jeton tourné, contexte du lien, `runs/` |
| `/var/lib/hermes-operator/`, `/run/hermes-operator/operator.sock` | root 0700 / 0750 | état et socket de l'opérateur |
| `/srv/hermes/data/` (`runtime.env`, `config.yaml`, profils, workspaces) | hermes, secrets 0600 | données runtime, bearer gateway, clés fournisseurs |
| `/usr/local/lib/hermes-agent`, `hermes-uv`, `hermes-node`, `hermes-bootstrap`, `/usr/local/share/hermes-python`, `/var/cache/hermes/uv` | root | arbres d'exécution (le service ne peut pas réécrire son interpréteur) |
| `/var/tmp/hermes-install.sh`, `/var/tmp/uv-*.tar.gz`, `/var/tmp/node-*.tar.xz` | root 0644 | téléchargements vérifiés par SHA-256 |
| `/etc/systemd/system/hermes-*.service`, `.timer`, `user@.service.d/delegate.conf` | root 0644 | unités |
| P7 : `/etc/ssh/sshd_config.d/00-hermes-hardening.conf`, `/etc/sudoers.d/80-hermes-admin`, `81-hermes-logging`, `/etc/fail2ban/jail.d/sshd.local`, `/etc/security/pwquality.conf.d/…`, `/etc/systemd/resolved.conf.d/…`, `/etc/apt/apt.conf.d/{20auto-upgrades,52-hermes-unattended}`, `/etc/logrotate.d/hermes-sudo`, `/var/backups/hermes-access/`, `/var/lib/hermes-host-hardening/` | root | politiques d'hôte, uniquement si l'option est choisie |
| `--sandbox` : `/etc/apt/sources.list.d/docker.sources`, clé APT Docker, `/etc/modules-load.d/hermes-docker.conf`, `~hermes/.config/systemd/user/docker.service` | root / hermes | Docker rootless |

Aucun fichier modifiable par tous n'a été trouvé dans les écrits du binaire.

## 3. Utilisateurs

| Compte | Création | Shell | sudo | Rôle |
|---|---|---|---|---|
| `hermes` | `useradd --system --user-group --shell /usr/sbin/nologin` | nologin | non | gateway et connecteur (même uid, isolés par espaces de noms systemd) |
| `hermes-admin` | `--ssh-hardening` seulement | `/bin/bash` | **`NOPASSWD: ALL`** (`/etc/sudoers.d/80-hermes-admin`) | administrateur SSH par clé, remplace le compte cloud-init |
| `debian` (existant) | `--quarantine-cloud-user` | passé en nologin, verrouillé | retiré | compte cloud-init mis en quarantaine |

## 4. Services systemd

| Unité | Utilisateur | Rôle | Confinement actuel |
|---|---|---|---|
| `hermes-gateway.service` | hermes | runtime Hermes (Python), API sur `127.0.0.1:8642` | NoNewPrivileges, PrivateTmp, `ProtectSystem=full`, `ProtectHome=tmpfs`, ProtectKernel*, RestrictSUIDSGID, RestrictAddressFamilies, IPAddressDeny métadonnées ; depuis le durcissement : CapabilityBoundingSet vide, SystemCallFilter=@system-service, RestrictNamespaces, PrivateDevices, PrivateUsers, ProtectProc=invisible, RemoveIPC ; **pas** de MemoryDenyWriteExecute (JIT Node.js), ProcSubset=pid, UMask=0027 |
| `hermes-connector.service` (+ `@<nom>`) | hermes | lien WebSocket sortant vers la console | `ProtectSystem=strict`, PrivatePIDs, MemoryDenyWriteExecute, InaccessiblePaths données ; **pas** de CapabilityBoundingSet vide, SystemCallFilter, PrivateDevices, RestrictNamespaces, ProtectKernelLogs |
| `hermes-operator.service` | **root** (voulu) | exécute `hermes auth add` en tant que `hermes` pour les verbes nommés de la console, via socket Unix | CapabilityBoundingSet réduit à SETUID/SETGID/CHOWN/FOWNER/DAC_OVERRIDE, SystemCallFilter=@system-service, `ProtectSystem=strict`, ReadWritePaths=/srv/hermes/data |
| `hermes-setup-upgrade.service/.timer` | root | mise à jour automatique (opt-in) | PrivateTmp seulement |
| `hermes-loopback-guard.service` | root | règles iptables owner-match sur lo:8642 (avec `--firewall`) | CapabilityBoundingSet NET_ADMIN/NET_RAW |
| `hermes-hardening-rollback.service/.timer` | root | retour arrière d'accès SSH | minimal |

## 5. Ports

- **Aucun port entrant ouvert par défaut.** Gateway : `127.0.0.1:8642`
  (loopback). Opérateur : socket Unix. Connecteur : client seulement.
- `--firewall --allow-inbound PORT/proto` ouvre explicitement des ports choisis
  par l'opérateur ; SSH 22 reste celui de l'hôte.
- L'ancienne exposition directe (Caddy) est retirée par `migrateLegacyDirect`.

## 6. Appels réseau sortants

| Destination | Quand | Vérification |
|---|---|---|
| `releases.openedbot.app` | amorçage, `upgrade`, `auto-upgrade`, `self-verify` | HTTPS + SHA-256 contre `SHA256SUMS` **non signé** |
| `raw.githubusercontent.com` (installeur Hermes) | P3 | tag + SHA-256 épinglés |
| `github.com` (dépôt Hermes, uv) | P3 | commit épinglé ; archive uv SHA-256 |
| `nodejs.org` | P3 | SHA-256 épinglé |
| PyPI / `files.pythonhosted.org` | P3 (`uv sync`) | `uv.lock` validé (hash obligatoire, git épinglé sur 40 hex) |
| Miroirs Debian/Ubuntu | P2, P7 | APT signé par la distribution |
| `download.docker.com`, registres d'images | `--sandbox` | clé GPG épinglée, images par digest |
| Console (`wss://…`, `--ohb`) | `link`, connecteur | TLS ; ticket + preuve de possession Ed25519 |
| Webhook Discord | alertes si configurées | URL fournie par l'opérateur |
| Fournisseurs de modèles | au fil des exécutions | hors edge-setup (runtime Hermes) |

## 7. Usage de root

- L'amorçage écrit `/usr/local/sbin/edge-setup` avec `sudo` (ou root).
- `up`, `link`, `upgrade`, `reset`, `uninstall`, `credentials`, `audit`
  exigent root (`requireRoot`, ou réexécution sous `sudo` depuis le lien PATH).
- L'installeur Hermes amont (`bash`, étape `repository` seulement) tourne en
  **root**, après vérification de son SHA-256.
- Au repos, trois unités tournent en root : `hermes-operator` (capacités
  réduites), `hermes-setup-upgrade` (opt-in), `hermes-loopback-guard` (opt-in).

## 8. Appairage et identité

- Ticket `<enrollmentId>.<secret>` : jamais en argv (refus explicite), lu sur
  une invite sans écho, sur stdin ou dans un fichier `0600`. Durée de vie
  côté API : **5 min** (`ENROLLMENT_TTL_MS`), usage unique (`consumed_at`).
- Identité : graine Ed25519 générée sur l'hôte, scellée par `systemd-creds`
  (TPM2 ou clé d'hôte), preuve de possession (`link.challenge`/`link.proof`) ;
  la clé privée ne quitte pas l'hôte.
- Rotation : jeton par trame `link.rotate`, clé par `link --rekey`.
  Révocation depuis la console : le connecteur sort en 78 et ne redémarre pas.

## 9. Écarts avec les exigences

| # | Exigence | État constaté | Écart |
|---|---|---|---|
| 1 | Signature des binaires et de `SHA256SUMS` | aucune (décision documentée dans `docs/RELEASING.md` : pas de minisign, cosign keyless prévu) | **à faire** : cosign keyless en CI, vérification dans l'amorçage et dans `upgrade` |
| 1 | Vérifier avant exécution, échec fermé | SHA-256 vérifié avant `install` ; échec fermé | signature à ajouter |
| 1 | Versions épinglées, pas de `latest` implicite | amorçage : `latest` par défaut ; `upgrade` sans `--version` lit le dernier | **à faire** |
| 1 | `curl --proto '=https' --tlsv1.2 -fsSL` | oui (+ `--proto-redir`) | — |
| 1 | `main` appelée à la fin, `set -euo pipefail` | `set -eu`, pas de `main`, `sh` POSIX (pas de `pipefail` garanti) | **à faire** |
| 2 | Utilisateur dédié sans shell ni sudo | oui, mais nommé `hermes` (contrat d'hôtes provisionnés) | divergence de nom, voir § 10 |
| 2 | Config 0640 root:groupe, secrets 0600 | secrets 0600 ; `allowlist.json`, `hermes-setup.json` à confirmer | **à vérifier/ajuster** |
| 2 | Aucune règle sudoers | `80-hermes-admin NOPASSWD: ALL` avec `--ssh-hardening` | voir § 10 |
| 3 | Unité verrouillée, score ≤ 2.0 | connecteur partiel ; gateway faible ; opérateur root | **à faire** (connecteur ≤ 2.0 ; gateway au mieux compatible ; opérateur mesuré) |
| 4 | Aucun port entrant | oui | — |
| 4 | Ticket ≤ 15 min, hors logs/historique | 5 min, stdin/fichier/invite | vérifier l'absence dans les logs |
| 4 | Identité par serveur, révocable, rotation | oui | `uninstall` ne révoque pas côté console |
| 5 | `--dry-run` | `plan` (up), `uninstall --plan`/`reset --plan` ; rien dans l'amorçage | **à faire** : alias `--dry-run`, amorçage |
| 5 | Uninstall propre + révocation console | uninstall local complet, **pas de révocation** | **à faire** |
| 5 | Mise à jour atomique avec retour arrière | automatique : oui ; **manuelle : non** | **à faire** |
| 5 | Journal d'installation sans secret | `layout.ToolJournal` déclaré, jamais écrit | **à faire** |
| 6 | shellcheck, tests du script, E2E Ubuntu/Debian, gitleaks en CI | tests bun de l'amorçage ; intégration Docker locale (non lancée en CI) ; gitleaks configuré, pas en CI | **à faire** |
| 7 | `SECURITY.md`, `docs/edge-setup-security.md` | `edge-setup/SECURITY.md` (URL d'advisory erronée), pas de racine, pas de doc de menace | **à faire** |

## 10. Conflits à trancher

1. **Nom du compte de service.** Le cahier des charges demande `openedbot`.
   L'existant utilise `hermes`, contrat avec les hôtes déjà provisionnés
   (`layout.go` : renommer impose une migration). Le gain de sécurité est nul.
2. **`hermes-admin` en `NOPASSWD: ALL`.** Créé uniquement avec
   `--ssh-hardening` ; il remplace le compte cloud-init qui avait le même droit.
   Le supprimer sans autre accès d'administration verrouillerait l'hôte.
3. **Opérateur root.** Nécessaire pour `runuser -u hermes` ; c'est
   l'« action privilégiée documentée et limitée » au sens du point 2, mais son
   score `systemd-analyze security` ne descendra pas à 2.0.
4. **Gateway.** Python + Docker rootless : chaque option a été prouvée sur un
   hôte Debian 13 réel (outil terminal dans le bac à sable Docker rootless via
   l'API, Python, Node.js, npx, git, `docker run`). `MemoryDenyWriteExecute`
   tue le JIT de Node.js, `ProcSubset=pid` masque `/proc/meminfo` et
   `/proc/cpuinfo`, retirer `@privileged`/`@resources` du filtre casse
   `fchown`/`nice` : ces options restent absentes.

## 11. Préparation open source

- `docs/RELEASING.md` cite un dépôt privé (`infra/releases.openedbot.app/`),
  « private monorepo », un dépôt personnel et un identifiant de plan interne.
- Tests et `CHANGELOG.md` citent un identifiant GitHub personnel (anciennes
  origines retirées, gardées comme garde-fous de régression).
- `SECURITY.md` pointe vers une URL d'advisory invalide
  (`…/openedbot/edge-setup/security/advisories/new`).
- Commits du dépôt déjà en adresse `noreply`.

## 12. État après durcissement

Relevé à la fin de la branche `fix/opened-bot-release` ; le détail est dans
[`../docs/edge-setup-security.md`](../docs/edge-setup-security.md).

| # | Exigence | État |
|---|---|---|
| 1 | Signature, vérification avant exécution, échec fermé | `SHA256SUMS` et chaque fichier signés keyless en CI (cosign, identité du workflow sur le tag de la version) ; amorçage (cosign épinglé par SHA-256), `upgrade`, `auto-upgrade` et `self-verify` (sigstore-go) vérifient signature puis SHA-256 avant d'écrire ou d'exécuter |
| 1 | Identité exacte, pas de retour arrière | identité comparée à l'identique (ni préfixe ni motif) pour le tag de la version demandée, installée (`self-verify`) ou lue une fois dans `LATEST` ; le binaire doit annoncer cette même version ; `upgrade` et `auto-upgrade` n'installent qu'une version strictement plus récente, `--allow-downgrade` (manuel seulement) accepte la même ou une plus ancienne, signée pour son propre tag ; version `vX.Y.Z` stricte, validée en shell par l'amorçage avant tout téléchargement (tests `internal/selfupdate/identity_test.go`, `internal/commands/release_identity_test.go`, `test/release/install-identity.sh`) |
| 1 | Versions épinglées | l'amorçage installe sa `PINNED_VERSION` ; `latest` et `--version` explicites ; `upgrade --version` |
| 1 | `main` en fin de script, `set -eu` + `pipefail` | oui (POSIX `sh`, `pipefail` là où le shell l'a) |
| 2 | Moindre privilège | compte `hermes` sans shell ni sudo (nom conservé) ; `fsx` refuse tout mode modifiable par tous ; umask hérité resserré (`\| 022`) ; audit `privileged_files` sur tous les arbres gérés ; contrôle `sudoers` |
| 2 | sudoers | aucune règle sans `--ssh-hardening` ; `hermes-admin NOPASSWD: ALL` conservé en option documentée |
| 3 | systemd ≤ 2.0 | connecteur 1.3 ; garde loopback 1.8 (réinstallé par `upgrade` si l'unité diffère) ; opérateur (root, voulu) 3.1 ; gateway 1.3 (charges d'agent ; `MemoryDenyWriteExecute`, `ProcSubset=pid` et `UMask=0027` écartés après mesure, voir le commentaire de l'unité) ; upgrade 7.0 ; rollback d'accès 8.8 inchangé (filet anti-verrouillage : il doit pouvoir réécrire sshd, UFW et sudoers) |
| 4 | Réseau, appairage | aucun port entrant ; ticket 5 min, usage unique, jamais en argv ni en en-tête autre qu'`Authorization` (tests) |
| 5 | `--dry-run` | `up`, `upgrade`, `uninstall`, `reset`, amorçage |
| 5 | Désinstallation et révocation | `uninstall` et `unlink` demandent la révocation (`link.retire`, preuve par la clé d'appareil) ; échec signalé, non bloquant |
| 5 | Mise à jour atomique avec retour arrière | manuelle et automatique, y compris finalisée en ligne ; prouvé sur l'hôte de lab |
| 5 | Journal sans secret | `/var/lib/hermes-setup/journal.jsonl`, root 0600, masquage, rotation 1 Mio |
| 6 | shellcheck, tests, E2E, gitleaks | `make shellcheck` (0 remarque, niveau style) ; tests bun de l'amorçage ; E2E conteneur systemd Ubuntu 24.04, 26.04, Debian 13 ; gitleaks sur chaque PR — tous en CI |
| 7 | Documentation | `SECURITY.md` racine, `edge-setup/SECURITY.md`, `docs/edge-setup-security.md` |
