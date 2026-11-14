import type { Template } from "./helpers";
import { text } from "./helpers";

function template(
  category: "approval" | "completed" | "failed",
  locale: "fr" | "en",
): Template {
  return (data) => {
    const titles =
      locale === "fr"
        ? {
            approval: "Votre accord est attendu",
            completed: "Votre mission est terminée",
            failed: "Votre mission demande une intervention",
          }
        : {
            approval: "Your approval is needed",
            completed: "Your task is complete",
            failed: "Your task needs attention",
          };
    const title = titles[category];
    return {
      subject: `${text(data.botName) || "openedbot"} — ${title}`,
      preheader: title,
      blocks: [
        { kind: "heading", text: title },
        { kind: "paragraph", text: text(data.botName) || "openedbot" },
        ...(text(data.conversationUrl)
          ? [
              {
                kind: "button" as const,
                label:
                  locale === "fr"
                    ? "Ouvrir la conversation"
                    : "Open conversation",
                url: text(data.conversationUrl),
              },
            ]
          : []),
      ],
      footerReason:
        locale === "fr"
          ? "Vous avez activé cette alerte dans Réglages > Notifications. Vous pouvez la désactiver à tout moment."
          : "You enabled this alert in Settings > Notifications. You can disable it at any time.",
    };
  };
}
export const WORKFLOW_TEMPLATES = {
  workflow_approval: {
    fr: template("approval", "fr"),
    en: template("approval", "en"),
  },
  workflow_completed: {
    fr: template("completed", "fr"),
    en: template("completed", "en"),
  },
  workflow_failed: {
    fr: template("failed", "fr"),
    en: template("failed", "en"),
  },
};
