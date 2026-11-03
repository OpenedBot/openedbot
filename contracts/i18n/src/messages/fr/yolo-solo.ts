/**
 * Mode YOLO, solo local : le YOLO par défaut d'une organisation à un seul
 * membre (`/settings/runtime`). Sans rapport avec le cœur « solo » sans
 * plug-ins.
 */
export const yoloSolo = {
  title: "YOLO par défaut (solo)",
  description:
    "Vous êtes seul dans cet espace : vos bots agissent sans demander, sur chacun de vos runtimes. openedbot renouvelle un bail de 24 h tant que vous restez le seul membre.",
  label: "YOLO par défaut (solo)",
  protections: "Toujours protégés, même en YOLO : .ssh, .env (et .env.*), le trousseau macOS, et la liste hardline.",
  endsWhen:
    "Il se coupe tout seul si quelqu’un rejoint l’espace, et avec « Couper YOLO partout » ou « edge-setup yolo off --yes » sur la machine.",
  loadFailed: "Impossible de lire le réglage YOLO par défaut.",
  on: "YOLO par défaut activé : le premier bail part vers vos runtimes.",
  off: "YOLO par défaut coupé : vos bots demandent de nouveau.",
  failed: "Le réglage YOLO par défaut n’a pas été enregistré.",
  notEligible: "Le YOLO par défaut est réservé à un espace dont vous êtes le seul membre.",
  confirmTitle: "Activer le YOLO par défaut ?",
  confirmDescription:
    "Vos bots écriront, exécuteront et installeront sans vous demander, sur toutes vos machines, jusqu’à ce que vous coupiez le mode. .ssh, .env, le trousseau et la liste hardline restent bloqués. Chaque auto-approbation est journalisée.",
  confirm: "Activer",
  confirmPending: "Activation…",
} as const;
