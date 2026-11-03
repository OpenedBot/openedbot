# `reset` : remettre l'hôte à zéro

L'outil se ré-exécute lui-même via `sudo` (voir `OPERATIONS.md`) : ne pas
préfixer `edge-setup` par `sudo`.

```bash
edge-setup reset --plan                       # liste, n'agit pas (alias --dry-run)
edge-setup reset --yes                        # retire runtime, unités, état, accès posés
edge-setup reset --yes --purge-data --i-understand-data-loss   # + /srv/hermes/data, /home/hermes
edge-setup reset --yes --purge-packages       # + docker-ce, containerd.io
edge-setup reset --yes --legacy               # + namespace openhermesbot-*
edge-setup reset --yes --legacy --purge-tailscale   # + tailscale (souvent votre accès)
```

## `uninstall` : désinstaller edge-setup

```bash
edge-setup uninstall --plan                   # liste, n'agit pas (alias --dry-run)
edge-setup uninstall --yes                    # demande : garder ou purger les données
edge-setup uninstall --yes --keep-data        # sans question, données gardées
edge-setup uninstall --yes --purge-data --i-understand-data-loss   # sans question, tout purgé
```

`uninstall` fait exactement le retrait de `reset` et accepte les mêmes
options (`--purge-packages`, `--legacy`, `--remove-admin`…). Au terminal, il
demande ce que deviennent les données du runtime (bearer, credentials,
workspaces) : Entrée les garde, `2` les purge après avoir tapé `purge`. Une
réponse absente ou différente annule tout, rien n'est modifié. Hors terminal
(script, `ssh hote edge-setup uninstall`), le choix doit venir de
`--keep-data` ou de `--purge-data --i-understand-data-loss`, sinon la commande
refuse.

Avant tout retrait, `uninstall` arrête chaque connecteur lié et demande à
openedbot de révoquer son runtime (trame `link.retire`), sur une session
prouvée par la clé d'appareil, comme toute reconnexion : une fois les liens
effacés, l'hôte ne pourrait plus prouver quel runtime il était. openedbot
révoque le runtime du jeton courant, le note dans le journal du lien
(`host_retired`) et le confirme (`link.retired`). Sans confirmation sous 20 s
(openedbot injoignable, ou plus ancien que cet outil), `uninstall` le dit,
donne où révoquer à la main (Réglages → Installation → Edge) et continue :
le retrait de l'hôte ne dépend jamais du réseau. `--plan` (alias `--dry-run`)
liste les runtimes qui seraient révoqués. `unlink` fait la même demande pour
sa seule instance, après la preuve d'arrêt du connecteur et avant d'effacer
le lien. `reset` ne révoque rien : il remet l'hôte à zéro, l'identité reste
dans openedbot.

`reset` comme `uninstall` retirent aussi les noms `edge-setup` et
`hermes-setup` (lien ou copie) de `/usr/local/bin`, `/usr/local/sbin` et
`/usr/sbin`. Un fichier posé par le paquet `.deb` reste en place et se retire
avec `apt remove edge-setup`.

Refusé tant que la transaction de durcissement
(`/var/lib/hermes-host-hardening/active`) est en cours.

## Ordre, et pourquoi il n'ouvre ni ne ferme jamais l'accès

1. Unités `hermes-connector`, `hermes-operator`, `hermes-gateway`,
   `hermes-loopback-guard` et timer de rollback d'accès :
   stop, disable, fichiers retirés. Les règles iptables `OUTPUT` du garde
   (ports 8642 et 9119) sont supprimées : cela rouvre ces ports en loopback,
   sans jamais fermer SSH.
2. Docker rootless de `hermes` : `systemctl --user disable --now docker`,
   linger, `delegate.conf`, `/etc/modules-load.d/hermes-docker.conf`, lignes
   `hermes:` de `/etc/subuid`/`/etc/subgid`.
3. Accès : **restauration, jamais fermeture**, uniquement pour les composants
   portant un marqueur de propriété HVS : drop-in sshd retiré ou remplacé
   par sa sauvegarde (`sshd -t` avant reload) ; jail fail2ban ; UFW restauré
   depuis les quatre fichiers sauvegardés, sinon `--force disable` et
   suppression des seules règles `Hermes-managed` ; drop-ins resolved,
   pwquality, sudoers de journalisation (`81-hermes-logging`), logrotate,
   apt ; puis `visudo -cf`. Une politique client sans marqueur est intacte.
   Le compte `hermes-admin` **et** son fichier
   `/etc/sudoers.d/80-hermes-admin` sont conservés : sans eux, la session qui
   lance le reset n'a plus de retour vers root. Le fichier n'est retiré que
   par `--remove-admin`, en même temps que le compte (compte supprimé, puis
   fichier, puis `visudo -cf`), ou s'il est orphelin (compte déjà absent).
   `--remove-admin` est refusé depuis la session de `hermes-admin`, avant
   toute modification. `--restore-cloud-user` rejoue la restauration du
   compte cloud-init depuis `/var/backups/hermes-access/`.
4. Fichiers du runtime : `/usr/local/lib/hermes-*`,
   `/usr/local/share/hermes-python`, `/var/cache/hermes`, archives sous
   `/var/tmp`, et `/run/hermes-operator` (socket de l'opérateur et marqueur
   « redémarrage en attente » du gateway). L'unité `hermes-operator` garde ce
   répertoire d'un redémarrage à l'autre (`RuntimeDirectoryPreserve=yes`) :
   systemd ne le vide plus quand le reset arrête l'unité, c'est donc le reset
   qui le retire, sinon il survivrait à `reset` et à `uninstall` jusqu'au
   prochain redémarrage de la machine.
5. État : `/var/lib/hermes-*`, `/var/backups/hermes-access`, `/etc/hermes`.
6. `--purge-data` : `/srv/hermes/data` et `/home/hermes` (bearer, clés
   fournisseur, workspaces). Exige `--i-understand-data-loss`.
7. `--purge-packages` : paquets Docker (`hold` levé d'abord), dépôt et clé APT ; les unités rootful
   sont démasquées. `ufw`, `fail2ban`, `unattended-upgrades` restent
   (paquets Debian standard).
8. Ancien compte `hermes-connector`, s'il provient d'une version précédente ;
   l'unique compte courant `hermes` n'est retiré qu'avec `--purge-data`. La
   copie `/usr/local/lib/hermes-setup/` est retirée en dernier, puis les noms
   `edge-setup` / `hermes-setup` du PATH qui n'appartiennent pas au paquet.
9. `--legacy` : drop-ins et unités `openhermesbot-*`, `/var/lib/openhermesbot*`,
   `/var/backups/openhermesbot-access`, `/var/cache/openhermesbot`,
   `/usr/local/lib/openhermesbot-*`, `/etc/openhermesbot`, conteneur
   `openhermesbot-hermes`, `/root/hermes-rename-*`, `tailscaled` + paquet +
   règles UFW `41641/udp` et `in on tailscale0`.

À la fin, `reset` liste tout résidu (`systemctl list-unit-files 'hermes-*'`,
chemins encore présents) et sort en erreur s'il en reste.

## Reconstruire depuis zéro

Sur un VPS provisionné par l'ancien outil, préférer la réinstallation depuis
une image propre chez le fournisseur : l'IP et l'empreinte hôte changent, et
c'est la seule façon d'être sûr de l'absence de reliquat. `reset --legacy`
existe pour les cas où reconstruire n'est pas possible.

Sur un hôte que l'ancien outil a déjà provisionné, `up` refuse deux états
qu'il ne peut pas auditer :

- un `hermes-admin` préexistant : « the admin account pre-exists and was not
  created by this tool ». Depuis une session **root** (l'opération est refusée
  depuis la session de `hermes-admin`), lancer
  `edge-setup reset --yes --remove-admin`, puis `edge-setup up` recrée le
  compte et son sudoers ;
- un compte cloud-init `debian` déjà neutralisé, sans `authorized_keys` :
  « debian exists without authorized_keys; refusing to quarantine an unaudited
  state ». Si ce compte n'a plus d'usage, le retirer à la main
  (`userdel -r debian`) avant de relancer `up`.
