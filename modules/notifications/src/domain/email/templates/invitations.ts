import { text, type TemplateFamily } from "./helpers";

/** Invitations d'une agence et d'un membre, et la réponse du client à l'agence. */
export const INVITATION_TEMPLATES = {
  agency_client_invitation: {
    fr: (data) => ({
      subject: `${text(data.agencyName)} vous invite sur openedbot`,
      preheader: "Votre invitation est valable 7 jours.",
      blocks: [
        { kind: "heading", text: `${text(data.agencyName)} vous invite` },
        { kind: "paragraph", text: "Vous choisirez explicitement de donner accès à vos runtimes, bots, conversations et exécutions. L'invitation expire dans 7 jours." },
        { kind: "button", label: "Voir l'invitation", url: text(data.invitationUrl) },
      ],
      footerReason: "Une agence vous a invité à collaborer sur openedbot.",
    }),
    en: (data) => ({
      subject: `${text(data.agencyName)} invites you to openedbot`,
      preheader: "Your invitation is valid for 7 days.",
      blocks: [
        { kind: "heading", text: `${text(data.agencyName)} invites you` },
        { kind: "paragraph", text: "You will explicitly choose whether to grant access to your runtimes, bots, conversations and executions. This invitation expires in 7 days." },
        { kind: "button", label: "View invitation", url: text(data.invitationUrl) },
      ],
      footerReason: "An agency invited you to collaborate on openedbot.",
    }),
  },
  organization_member_invitation: {
    fr: (data) => ({
      subject: `${text(data.organizationName)} vous invite à rejoindre son équipe openedbot`,
      preheader: "Votre invitation est valable 7 jours.",
      blocks: [
        { kind: "heading", text: `${text(data.organizationName)} vous invite` },
        { kind: "paragraph", text: `Vous êtes invité comme ${text(data.role) === "admin" ? "administrateur" : "membre"}. L'invitation expire dans 7 jours.` },
        { kind: "button", label: "Voir l'invitation", url: text(data.invitationUrl) },
      ],
      footerReason: "Vous avez reçu une invitation à rejoindre une organisation openedbot.",
    }),
    en: (data) => ({
      subject: `${text(data.organizationName)} invites you to join its openedbot team`,
      preheader: "Your invitation is valid for 7 days.",
      blocks: [
        { kind: "heading", text: `${text(data.organizationName)} invites you` },
        { kind: "paragraph", text: `You are invited as ${text(data.role) === "admin" ? "an administrator" : "a member"}. This invitation expires in 7 days.` },
        { kind: "button", label: "View invitation", url: text(data.invitationUrl) },
      ],
      footerReason: "You received an invitation to join an openedbot organization.",
    }),
  },
  agency_client_response: {
    fr: (data) => ({
      subject: `Invitation ${text(data.status) === "accepted" ? "acceptée" : "refusée"}`,
      preheader: text(data.email),
      blocks: [{ kind: "paragraph", text: `${text(data.email)} a ${text(data.status) === "accepted" ? "accepté" : "refusé"} votre invitation.` }],
      footerReason: "Vous avez envoyé cette invitation depuis votre agence openedbot.",
    }),
    en: (data) => ({
      subject: `Invitation ${text(data.status) === "accepted" ? "accepted" : "declined"}`,
      preheader: text(data.email),
      blocks: [{ kind: "paragraph", text: `${text(data.email)} ${text(data.status) === "accepted" ? "accepted" : "declined"} your invitation.` }],
      footerReason: "You sent this invitation from your openedbot agency.",
    }),
  },
} satisfies TemplateFamily;
