import type { EmailBlock } from "../design";
import { formatTime, text, type TemplateFamily } from "./helpers";

/** Ce qui ne s'est pas vérifié dans la chaîne, dit à un humain. */
const QUARANTINE_REASONS: Record<string, { fr: string; en: string }> = {
  hash_mismatch: { fr: "une entrée ne correspond pas à son hash", en: "an entry does not match its hash" },
  prev_mismatch: { fr: "la tranche ne suit pas la dernière entrée reçue", en: "the slice does not follow the last entry received" },
  seq_gap: { fr: "des entrées manquent avant cette tranche", en: "entries are missing before this slice" },
  conflict: { fr: "une entrée déjà reçue revient avec un autre contenu", en: "an entry already received came back with other content" },
  unknown_lease: { fr: "une entrée cite un bail que ce runtime n’a jamais reçu", en: "an entry names a lease this runtime never received" },
};

function reasonOf(value: unknown, locale: "fr" | "en"): string {
  const code = text(value);
  return Object.hasOwn(QUARANTINE_REASONS, code) ? QUARANTINE_REASONS[code]![locale] : code;
}

function range(data: Record<string, unknown>): string {
  const from = typeof data.fromSeq === "number" ? data.fromSeq : null;
  const to = typeof data.toSeq === "number" ? data.toSeq : null;
  if (from === null || to === null) return "";
  return from === to ? String(from) : `${from}–${to}`;
}

/** Le mode YOLO : l'audit des auto-approbations d'un hôte ne se vérifie plus. */
export const YOLO_TEMPLATES = {
  /**
   * Une tranche `yolo.audit` dont la chaîne ne se vérifie pas a été mise en
   * quarantaine (`modules/runtime-link/src/application/link-yolo.ts`) : elle
   * est gardée, pas jetée, et les owners et admins l'apprennent. Hash et
   * métadonnées seulement : le message ne cite aucun argument.
   */
  yolo_audit_quarantined: {
    fr: (data) => {
      const runtimeName = text(data.runtimeName) || "votre runtime";
      const reason = reasonOf(data.reason, "fr");
      const seqs = range(data);
      const receivedAt = formatTime(text(data.receivedAt), "fr");
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `Audit YOLO de ${runtimeName} mis en quarantaine`,
        preheader: "Des auto-approbations rapportées par cette machine ne se vérifient pas : elles sont gardées à part.",
        blocks: [
          { kind: "heading", text: `L’audit YOLO de ${runtimeName} ne se vérifie pas` },
          {
            kind: "paragraph",
            text: "Cette machine a envoyé des entrées « auto-approuvé (YOLO) » dont la chaîne de hash ne se vérifie pas. openedbot les a gardées en quarantaine au lieu de les ajouter au journal : rien n’est perdu, mais ce journal ne fait plus foi à cet endroit.",
          },
          {
            kind: "rows",
            rows: [
              ["Runtime", runtimeName],
              ...(reason ? ([["Constat", reason]] as Array<[string, string]>) : []),
              ...(seqs ? ([["Entrées", seqs]] as Array<[string, string]>) : []),
              ...(receivedAt ? ([["Reçues à", receivedAt]] as Array<[string, string]>) : []),
            ],
          },
          {
            kind: "paragraph",
            text: "Si personne n’a touché aux fichiers d’état de la machine, coupez le mode YOLO (« Couper YOLO partout », ou « edge-setup yolo off --yes » sur la machine) et vérifiez-la avant de le rallumer.",
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Ouvrir les réglages du runtime", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "Vous recevez ce message parce que vous administrez cette organisation openedbot.",
      };
    },
    en: (data) => {
      const runtimeName = text(data.runtimeName) || "your runtime";
      const reason = reasonOf(data.reason, "en");
      const seqs = range(data);
      const receivedAt = formatTime(text(data.receivedAt), "en");
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `YOLO audit of ${runtimeName} quarantined`,
        preheader: "Auto-approvals reported by this machine do not verify: they are kept aside.",
        blocks: [
          { kind: "heading", text: `The YOLO audit of ${runtimeName} does not verify` },
          {
            kind: "paragraph",
            text: "This machine sent \"auto-approved (YOLO)\" entries whose hash chain does not verify. openedbot kept them in quarantine instead of adding them to the log: nothing is lost, but the log can no longer be trusted at that point.",
          },
          {
            kind: "rows",
            rows: [
              ["Runtime", runtimeName],
              ...(reason ? ([["Finding", reason]] as Array<[string, string]>) : []),
              ...(seqs ? ([["Entries", seqs]] as Array<[string, string]>) : []),
              ...(receivedAt ? ([["Received at", receivedAt]] as Array<[string, string]>) : []),
            ],
          },
          {
            kind: "paragraph",
            text: "If nobody touched the machine's state files, turn YOLO mode off (\"Turn YOLO off everywhere\", or \"edge-setup yolo off --yes\" on the machine) and check it before turning it on again.",
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Open runtime settings", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "You are getting this message because you administer this openedbot organization.",
      };
    },
  },
  /**
   * Le YOLO par défaut du mode solo local vient d'être coupé : l'organisation
   * compte désormais plus d'un membre (`reconcileYoloSoloDefault`,
   * `modules/execution/src/application/yolo-leases.ts`). Ses baux solo sont
   * révoqués et le consentement remis à false ; l'owner le rallumera s'il
   * revient seul, ou octroiera des baux à la main.
   */
  yolo_solo_default_ended: {
    fr: (data) => {
      const organizationName = text(data.organizationName) || "votre organisation";
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `YOLO par défaut coupé pour ${organizationName}`,
        preheader: "Un deuxième membre a rejoint l’organisation : chaque action sensible demande de nouveau une approbation.",
        blocks: [
          { kind: "heading", text: "Le YOLO par défaut est coupé" },
          {
            kind: "paragraph",
            text: `${organizationName} compte désormais plus d’un membre. Le YOLO par défaut est réservé à une organisation où vous êtes seul : openedbot a révoqué ses baux et l’a désactivé.`,
          },
          {
            kind: "paragraph",
            text: "Vos bots demandent de nouveau une approbation pour chaque action sensible. Un owner ou un admin peut encore activer le mode YOLO pour une conversation, un bot ou un runtime, pour une durée limitée.",
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Ouvrir les réglages du runtime", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "Vous recevez ce message parce que vous êtes propriétaire de cette organisation openedbot.",
      };
    },
    en: (data) => {
      const organizationName = text(data.organizationName) || "your organization";
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `Default YOLO turned off for ${organizationName}`,
        preheader: "A second member joined the organization: every sensitive action asks for approval again.",
        blocks: [
          { kind: "heading", text: "Default YOLO is off" },
          {
            kind: "paragraph",
            text: `${organizationName} now has more than one member. Default YOLO is only for an organization where you are alone: openedbot revoked its leases and turned it off.`,
          },
          {
            kind: "paragraph",
            text: "Your bots ask for approval again for every sensitive action. An owner or an admin can still turn YOLO mode on for a conversation, a bot or a runtime, for a limited time.",
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Open runtime settings", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "You are getting this message because you own this openedbot organization.",
      };
    },
  },
} satisfies TemplateFamily;
