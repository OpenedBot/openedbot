import type { EmailBlock } from "../design";
import { formatTime, text, type TemplateFamily } from "./helpers";

/** Le runtime : quota fournisseur, lien coupé puis rétabli, connecteur périmé. */
export const RUNTIME_TEMPLATES = {
  provider_quota_reached: {
    fr: (data) => {
      const provider = text(data.provider) || "fournisseur";
      const occurredAt = formatTime(text(data.occurredAt), "fr");
      const fallback = text(data.fallback) || "aucun";
      const settingsUrl = text(data.settingsUrl);
      const auth = text(data.kind) === "auth";
      return {
        subject: auth ? `Fournisseur ${provider} déconnecté` : `Quota atteint sur ${provider}`,
        preheader: auth
          ? `Les runs de ${provider} échouent tant qu’il n’est pas réauthentifié.`
          : `Les runs continuent sur le repli : ${fallback}.`,
        blocks: [
          { kind: "heading", text: auth ? `${provider} n’est plus authentifié` : `${provider} a atteint son quota` },
          {
            kind: "paragraph",
            text: auth
              ? `Le fournisseur ${provider} n’est plus authentifié : ses runs échouent.`
              : `Le fournisseur ${provider} a atteint son quota. Les runs continuent sur le repli.`,
          },
          {
            kind: "rows",
            rows: [
              ["Fournisseur", provider],
              ...(occurredAt ? ([["Constaté à", occurredAt]] as Array<[string, string]>) : []),
              ["Repli retenu", fallback],
            ],
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Ouvrir les réglages Modèles", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "Vous recevez ce message parce que vous administrez cette organisation openedbot.",
      };
    },
    en: (data) => {
      const provider = text(data.provider) || "provider";
      const occurredAt = formatTime(text(data.occurredAt), "en");
      const fallback = text(data.fallback) || "none";
      const settingsUrl = text(data.settingsUrl);
      const auth = text(data.kind) === "auth";
      return {
        subject: auth ? `Provider ${provider} disconnected` : `Quota reached on ${provider}`,
        preheader: auth
          ? `Runs on ${provider} fail until it is authenticated again.`
          : `Runs continue on the fallback: ${fallback}.`,
        blocks: [
          { kind: "heading", text: auth ? `${provider} is no longer authenticated` : `${provider} reached its limit` },
          {
            kind: "paragraph",
            text: auth
              ? `Provider ${provider} is no longer authenticated: its runs fail.`
              : `Provider ${provider} has reached its usage limit. Runs continue on the fallback.`,
          },
          {
            kind: "rows",
            rows: [
              ["Provider", provider],
              ...(occurredAt ? ([["Seen at", occurredAt]] as Array<[string, string]>) : []),
              ["Fallback chosen", fallback],
            ],
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Open model settings", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "You are getting this message because you administer this openedbot organization.",
      };
    },
  },
  /**
   * Le connector d'un runtime ne joint plus openedbot depuis plusieurs minutes
   * (`modules/runtime-link/src/application/link-alerts.ts`). Le message dit ce
   * qui s'arrête et les deux gestes qui le réparent, sans jeton ni adresse IP.
   */
  runtime_link_down: {
    fr: (data) => {
      const runtimeName = text(data.runtimeName) || "votre runtime";
      const downSince = formatTime(text(data.downSince), "fr");
      const reason = text(data.reason);
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `${runtimeName} ne répond plus`,
        preheader: "Vos bots sur cette machine ne répondent plus tant que le lien n’est pas rétabli.",
        blocks: [
          { kind: "heading", text: `${runtimeName} est déconnecté` },
          {
            kind: "paragraph",
            text: "Le connector de cette machine ne joint plus openedbot. Les runs qui l’attendent échouent tant que le lien n’est pas rétabli.",
          },
          {
            kind: "rows",
            rows: [
              ["Runtime", runtimeName],
              ...(downSince ? ([["Coupé depuis", downSince]] as Array<[string, string]>) : []),
              ...(reason ? ([["Raison", reason]] as Array<[string, string]>) : []),
            ],
          },
          {
            kind: "paragraph",
            text: "Sur la machine, lancez « edge-setup status » puis « edge-setup doctor ». Si le lien a été refusé, réappairez-la avec un nouveau ticket depuis les réglages.",
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Ouvrir les réglages du runtime", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "Vous recevez ce message parce que vous avez relié ce runtime ou que vous administrez cette organisation openedbot.",
      };
    },
    en: (data) => {
      const runtimeName = text(data.runtimeName) || "your runtime";
      const downSince = formatTime(text(data.downSince), "en");
      const reason = text(data.reason);
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `${runtimeName} is not responding`,
        preheader: "Your bots on this machine stop answering until the link is back.",
        blocks: [
          { kind: "heading", text: `${runtimeName} is disconnected` },
          {
            kind: "paragraph",
            text: "The connector on this machine no longer reaches openedbot. Runs waiting for it fail until the link is back.",
          },
          {
            kind: "rows",
            rows: [
              ["Runtime", runtimeName],
              ...(downSince ? ([["Down since", downSince]] as Array<[string, string]>) : []),
              ...(reason ? ([["Reason", reason]] as Array<[string, string]>) : []),
            ],
          },
          {
            kind: "paragraph",
            text: "On the machine, run \"edge-setup status\" then \"edge-setup doctor\". If the link was refused, pair it again with a new ticket from the settings.",
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Open runtime settings", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "You are getting this message because you linked this runtime or administer this openedbot organization.",
      };
    },
  },
  /**
   * Le connector d'un runtime signalé par `runtime_link_down` a rejoint openedbot
   * (`modules/runtime-link/src/application/link-alerts.ts`) : les mêmes
   * destinataires apprennent que c'est revenu, sans avoir à surveiller la
   * console. Jamais envoyé pour une révocation ou une suppression.
   */
  runtime_link_restored: {
    fr: (data) => {
      const runtimeName = text(data.runtimeName) || "votre runtime";
      const downSince = formatTime(text(data.downSince), "fr");
      const restoredAt = formatTime(text(data.restoredAt), "fr");
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `${runtimeName} est de nouveau connecté`,
        preheader: "Vos bots sur cette machine répondent de nouveau.",
        blocks: [
          { kind: "heading", text: `${runtimeName} est de retour` },
          {
            kind: "paragraph",
            text: "Le connector de cette machine a rejoint openedbot : vos bots répondent de nouveau. Les runs qui ont échoué pendant la coupure ne repartent pas d’eux-mêmes ; relancez-les depuis leur conversation si besoin.",
          },
          {
            kind: "rows",
            rows: [
              ["Runtime", runtimeName],
              ...(downSince ? ([["Coupé depuis", downSince]] as Array<[string, string]>) : []),
              ...(restoredAt ? ([["Rétabli à", restoredAt]] as Array<[string, string]>) : []),
            ],
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Ouvrir les réglages du runtime", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "Vous recevez ce message parce que vous avez été prévenu de la coupure de ce runtime.",
      };
    },
    en: (data) => {
      const runtimeName = text(data.runtimeName) || "your runtime";
      const downSince = formatTime(text(data.downSince), "en");
      const restoredAt = formatTime(text(data.restoredAt), "en");
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `${runtimeName} is connected again`,
        preheader: "Your bots on this machine answer again.",
        blocks: [
          { kind: "heading", text: `${runtimeName} is back` },
          {
            kind: "paragraph",
            text: "The connector on this machine reached openedbot again: your bots answer again. Runs that failed during the outage do not restart by themselves; run them again from their conversation if needed.",
          },
          {
            kind: "rows",
            rows: [
              ["Runtime", runtimeName],
              ...(downSince ? ([["Down since", downSince]] as Array<[string, string]>) : []),
              ...(restoredAt ? ([["Back at", restoredAt]] as Array<[string, string]>) : []),
            ],
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Open runtime settings", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "You are getting this message because you were told this runtime was down.",
      };
    },
  },
  /**
   * The connector of a runtime announced a version below the required minimum
   * (`modules/runtime-link/src/application/connector-notices.ts`). Sent once
   * per (runtime, installed version, target version). It names the command to
   * run on the machine and says that openedbot cannot run it: openedbot never updates a
   * customer host.
   */
  runtime_connector_outdated: {
    fr: (data) => {
      const runtimeName = text(data.runtimeName) || "votre runtime";
      const installedVersion = text(data.installedVersion);
      const targetVersion = text(data.targetVersion);
      const latestVersion = text(data.latestVersion);
      const upgradeCommand = text(data.upgradeCommand) || "sudo edge-setup upgrade --yes";
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `Mettez à jour le connector de ${runtimeName}`,
        preheader: "Une commande à lancer sur la machine : openedbot ne peut pas la mettre à jour à votre place.",
        blocks: [
          { kind: "heading", text: `Le connector de ${runtimeName} doit être mis à jour` },
          {
            kind: "paragraph",
            text: "Cette machine fait tourner une version du connector plus ancienne que celle qu’openedbot exige désormais. Le lien reste ouvert, mais mettez-la à jour pour garder toutes les fonctions.",
          },
          {
            kind: "rows",
            rows: [
              ["Runtime", runtimeName],
              ...(installedVersion ? ([["Version installée", installedVersion]] as Array<[string, string]>) : []),
              ...(targetVersion ? ([["Version minimale", targetVersion]] as Array<[string, string]>) : []),
              ...(latestVersion && latestVersion !== targetVersion
                ? ([["Dernière version", latestVersion]] as Array<[string, string]>)
                : []),
            ],
          },
          { kind: "paragraph", text: `Sur la machine, lancez : « ${upgradeCommand} »` },
          {
            kind: "note",
            text: "openedbot ne peut pas mettre à jour votre machine lui-même : il n’y ouvre aucune session et n’y lance aucune commande. Seule une personne qui administre la machine peut lancer cette mise à jour.",
          },
          ...(settingsUrl
            ? ([{ kind: "button", label: "Ouvrir les réglages du runtime", url: settingsUrl }] as EmailBlock[])
            : []),
        ],
        footerReason: "Vous recevez ce message parce que vous êtes propriétaire de cette organisation openedbot.",
      };
    },
    en: (data) => {
      const runtimeName = text(data.runtimeName) || "your runtime";
      const installedVersion = text(data.installedVersion);
      const targetVersion = text(data.targetVersion);
      const latestVersion = text(data.latestVersion);
      const upgradeCommand = text(data.upgradeCommand) || "sudo edge-setup upgrade --yes";
      const settingsUrl = text(data.settingsUrl);
      return {
        subject: `Update the connector of ${runtimeName}`,
        preheader: "One command to run on the machine: openedbot cannot update it for you.",
        blocks: [
          { kind: "heading", text: `The connector of ${runtimeName} must be updated` },
          {
            kind: "paragraph",
            text: "This machine runs a connector version older than the one openedbot now requires. The link stays open, but update it to keep every feature working.",
          },
          {
            kind: "rows",
            rows: [
              ["Runtime", runtimeName],
              ...(installedVersion ? ([["Installed version", installedVersion]] as Array<[string, string]>) : []),
              ...(targetVersion ? ([["Minimum version", targetVersion]] as Array<[string, string]>) : []),
              ...(latestVersion && latestVersion !== targetVersion
                ? ([["Latest version", latestVersion]] as Array<[string, string]>)
                : []),
            ],
          },
          { kind: "paragraph", text: `On the machine, run: "${upgradeCommand}"` },
          {
            kind: "note",
            text: "openedbot cannot update your machine itself: it opens no session on it and runs no command there. Only someone who administers the machine can run this update.",
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
