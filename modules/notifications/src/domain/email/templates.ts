import { OPENEDBOT_SUPPORT_DISCORD_URL } from "../discord";
import { type EmailDocument, renderEmailHtml, renderEmailText } from "./design";
import { type TransactionalEmailKind, transactionalEmailLocale, type TransactionalEmailLocale } from "@openedbot/contracts-api";
import type { Template } from "./templates/helpers";
import { INVITATION_TEMPLATES } from "./templates/invitations";
import { ACCOUNT_TEMPLATES } from "./templates/account";
import { RUNTIME_TEMPLATES } from "./templates/runtime";
import { WORKFLOW_TEMPLATES } from "./templates/workflow";

export { OPENEDBOT_SUPPORT_DISCORD_URL };

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

/**
 * Tous les gabarits, une famille par fichier (`templates/<famille>.ts`). Le
 * type exige chaque genre dans chaque langue : un genre oublié ne compile pas.
 */
const TEMPLATES: Record<TransactionalEmailKind, Record<TransactionalEmailLocale, Template>> = {
  ...INVITATION_TEMPLATES,
  ...ACCOUNT_TEMPLATES,
  ...RUNTIME_TEMPLATES,
  ...WORKFLOW_TEMPLATES,
};

export function renderTransactionalEmail(message: {
  kind: TransactionalEmailKind;
  locale: string;
  data: Record<string, unknown>;
}): RenderedEmail {
  // Une ligne sans langue lisible part dans la langue par défaut du produit.
  const locale = transactionalEmailLocale(message.locale);
  // A row of a kind the core no longer renders (left in the outbox by a
  // plug-in that is gone) fails with a reason, like any render failure.
  const family = TEMPLATES[message.kind] as Record<TransactionalEmailLocale, Template> | undefined;
  if (!family) throw new Error(`No email template for the kind ${JSON.stringify(message.kind)}.`);
  const document: EmailDocument = { locale, ...family[locale](message.data) };
  return {
    subject: document.subject,
    text: renderEmailText(document),
    html: renderEmailHtml(document),
  };
}
