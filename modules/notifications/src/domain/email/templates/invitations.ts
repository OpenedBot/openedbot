import { text, type TemplateFamily } from "./helpers";

/** L'invitation d'une personne dans l'espace de celui qui l'invite. */
export const INVITATION_TEMPLATES = {
  organization_member_invitation: {
    fr: (data) => ({
      subject: `${text(data.organizationName)} vous invite à rejoindre son équipe openedbot`,
      preheader: "Votre invitation est valable 7 jours.",
      blocks: [
        { kind: "heading", text: `${text(data.organizationName)} vous invite` },
        { kind: "paragraph", text: `Vous êtes invité comme ${text(data.role) === "admin" ? "administrateur" : "membre"}. L'invitation expire dans 7 jours.` },
        { kind: "button", label: "Voir l'invitation", url: text(data.invitationUrl) },
      ],
      footerReason: "Vous avez reçu une invitation à rejoindre un espace openedbot.",
    }),
    en: (data) => ({
      subject: `${text(data.organizationName)} invites you to join its openedbot team`,
      preheader: "Your invitation is valid for 7 days.",
      blocks: [
        { kind: "heading", text: `${text(data.organizationName)} invites you` },
        { kind: "paragraph", text: `You are invited as ${text(data.role) === "admin" ? "an administrator" : "a member"}. This invitation expires in 7 days.` },
        { kind: "button", label: "View invitation", url: text(data.invitationUrl) },
      ],
      footerReason: "You received an invitation to join an openedbot workspace.",
    }),
  },
} satisfies TemplateFamily;
