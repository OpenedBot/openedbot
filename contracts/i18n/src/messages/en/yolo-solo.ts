/**
 * YOLO mode, solo local: the default YOLO of a one-member organization
 * (`/settings/runtime`). Unrelated to the "solo" core without plug-ins.
 */
export const yoloSolo = {
  title: "Default YOLO (solo)",
  description:
    "You are alone in this workspace: your bots act without asking, on each of your runtimes. openedbot renews a 24 h lease as long as you remain the only member.",
  label: "Default YOLO (solo)",
  protections: "Always protected, even in YOLO: .ssh, .env (and .env.*), the macOS keychain, and the hardline list.",
  endsWhen:
    "It turns itself off if someone joins the workspace, and with \"Turn YOLO off everywhere\" or \"edge-setup yolo off --yes\" on the machine.",
  loadFailed: "Could not read the default YOLO setting.",
  on: "Default YOLO on: the first lease is on its way to your runtimes.",
  off: "Default YOLO off: your bots ask again.",
  failed: "The default YOLO setting was not saved.",
  notEligible: "Default YOLO is only for a workspace where you are the only member.",
  confirmTitle: "Turn default YOLO on?",
  confirmDescription:
    "Your bots will write, run and install without asking, on all your machines, until you turn the mode off. .ssh, .env, the keychain and the hardline list stay blocked. Every auto-approval is logged.",
  confirm: "Turn on",
  confirmPending: "Turning on…",
} as const;
