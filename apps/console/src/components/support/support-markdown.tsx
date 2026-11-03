import { memo } from "react";
import {
  SupportMarkdown as SharedSupportMarkdown,
  type SupportMarkdownClasses,
} from "@openedbot/browser-ui-kit/components/support-markdown";

/**
 * Le texte d'un message de support, en markdown restreint : le rendu est celui
 * de `@openedbot/browser-ui-kit`, partagé avec le backoffice. Ici seulement l'échelle
 * de la bulle, un cran sous le texte courant pour le code et le tableau.
 */
const CLASSES: SupportMarkdownClasses = {
  code: "text-[0.9em]",
  pre: "text-[0.9em]",
  table: "text-[0.95em]",
};

export const SupportMarkdown = memo(function SupportMarkdown({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  return <SharedSupportMarkdown body={body} className={className} classes={CLASSES} />;
});
