# Intégration conteneur

`make integration` construit `dist/edge-setup`, lance un conteneur Debian 13
avec systemd (`--privileged`, cgroupns hôte), y copie le binaire et joue les
scénarios de `integration_test.go` (`-tags integration`). Le réseau sortant est
requis (apt, GitHub pour l'installeur Hermes et uv).

`EDGE_SETUP_IT_BASE` change l'image de base (`ubuntu:24.04`, `ubuntu:26.04`,
`debian:bookworm`). Hors Debian 13, seuls `TestReadOnlyCommandsOnFreshHost` et
`TestUpConnectorNoSSHHardening` ont un sens : les protections optionnelles y
sont refusées par le préflight. Le CI (`edge-setup-ci.yml`, job `e2e`) joue ces
deux scénarios sur Debian 12, Debian 13, Ubuntu 24.04 et Ubuntu 26.04
(sur le runner `amd64` ; aucune preuve `arm64` par cette matrice).

`TestUpConnectorNoSSHHardening` couvre aussi la fin de vie : `up --dry-run` et
`uninstall --dry-run` n'écrivent rien sous `/etc` ni `/usr/local` et sont
inscrits au journal root 0600 ; `uninstall --yes --keep-data`, avec un lien
dont l'origine est injoignable, signale que la révocation n'a pas été
confirmée, retire unités et commande, garde les données ; `reset
--purge-data` ne laisse aucun résidu.

Non couvert ici, réservé à `make integration-vm` : docker rootless, mesure des
limites cgroup. Le script VM actuel vérifie une nouvelle session SSH mais
ne redémarre pas la VM et ne lie pas de runtime à openedbot. Reboot,
reconnexion cloud et upgrade/rollback restent des gates distinctes de la
recette de release, exécutées sur chaque candidat.
ACME ne fait pas partie de ce runner.
