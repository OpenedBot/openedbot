# Proxmox / LXC : pièges mesurés

`edge-setup` tourne aussi dans un conteneur LXC non privilégié (Proxmox VE).
Ce qui suit a été mesuré sur le lab, pas déduit.

- **Subuid** : l'espace d'UID d'un CT non privilégié s'arrête à 65535
  (`/proc/self/uid_map` rend `0 100000 65536`). La plage VM par défaut
  (`300000:65536`) y produit « newuidmap: write to uid_map failed » et un
  dockerd rootless mort au boot. `detect` relève `virt=lxc` et `up` prend
  `10000:55000` ; toute plage qui déborderait est refusée **avant** l'écriture
  de `/etc/subuid`.
- **Nesting** : sans `features: nesting=1,keyctl=1`, le rootless ne démarre
  pas. Ne sélectionnez simplement pas `--sandbox` : les outils tournent sous
  `hermes` avec le cloisonnement systemd du runtime, et l'audit sandbox est `SKIP`.
  Ne jamais rendre le CT privilégié pour « faire marcher docker ».
- **AppArmor** : le profil de confinement est relevé, jamais asserté, il rend
  `unconfined` sur un hôte sans AppArmor et produirait un faux refus.
- **Gateway en `0.0.0.0` + `terminal.backend: local`** : tout appel authentifié
  exécute du code dans le CT ; la clé API est alors le seul rempart sur le LAN.
  L'outil impose `127.0.0.1:8642` et `doctor` refuse un listener wildcard.
- **Ne jamais redémarrer le gateway pendant des runs** : un restart les tue.
  `up` ne redémarre que si une clé `terminal.*` a changé (lecture avant
  écriture).
