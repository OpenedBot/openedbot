import { memo, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";

/**
 * Un texte court en markdown restreint : les notes de version d'un connecteur
 * dans la console (`connector-update-dialog.tsx`), les messages de la file du
 * backoffice.
 *
 * Pas `ThreadMarkdown` : celui-là rend des alertes GitHub, des maths KaTeX et
 * des blocs de code avec bouton de copie, dans une colonne pleine largeur. Ici
 * le texte vit dans un cadre étroit, et ce qu'on y écrit est du gras, une
 * liste, un lien, un bout de code, un tableau. Charger de quoi rendre une
 * équation serait payer une dépendance pour un cas qui n'arrive pas.
 *
 * `remarkBreaks` pour la même raison que dans le fil des bots : un retour à la
 * ligne est une intention, pas un accident de formatage.
 *
 * AUCUN HTML brut n'est rendu, et c'est la garantie qui compte ici : le texte
 * vient d'ailleurs, et `react-markdown` ignore l'HTML par défaut (il faudrait
 * `rehype-raw` pour l'activer). Un `<script>` ou un `<img onerror>` s'affiche
 * donc comme du texte.
 *
 * Le comportement est ici, l'habillage de chaque app est injecté : `className`
 * pour l'enveloppe, `classes` pour ce qui varie d'une charte à l'autre (la
 * taille du code et du tableau).
 */

const remarkPlugins = [remarkGfm, remarkBreaks];

export type SupportMarkdownClasses = {
  /** Ajouté au `<code>` (en ligne et en bloc). */
  code?: string;
  /** Ajouté au `<pre>`. */
  pre?: string;
  /** Ajouté au `<table>`. */
  table?: string;
};

/**
 * Les liens s'ouvrent dans un onglet neuf, avec `noreferrer`.
 *
 * Un lien écrit par un inconnu ne doit ni emporter la conversation en cours,
 * ni recevoir l'adresse de la page d'où on vient : `rel` n'est pas une
 * décoration, c'est ce qui empêche `window.opener` de reprendre la main.
 */
function buildComponents(classes: SupportMarkdownClasses | undefined): Components {
  return {
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="underline decoration-current/40 underline-offset-2 hover:decoration-current"
      >
        {children}
      </a>
    ),
    // Les marges par défaut d'un `<p>` doubleraient le rembourrage de la bulle.
    p: ({ children }) => <p className="whitespace-pre-wrap break-words">{children}</p>,
    ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
    code: ({ children, className }) =>
      // Un bloc (```) porte une classe `language-…` ; l'inline n'en a pas. Les
      // deux ne se traitent pas pareil : l'un respire, l'autre reste dans la
      // phrase.
      className?.startsWith("language-")
        ? <code className={cn("font-mono", classes?.code)}>{children}</code>
        : <code className={cn("rounded bg-current/10 px-1 py-px font-mono", classes?.code)}>{children}</code>,
    pre: ({ children }) => (
      <pre className={cn("my-1 overflow-x-auto rounded-lg bg-current/10 p-2", classes?.pre)}>{children}</pre>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-1 border-l-2 border-current/30 pl-2 italic">{children}</blockquote>
    ),
    table: ({ children }) => (
      <div className="my-1 overflow-x-auto">
        <table className={cn("w-full border-collapse", classes?.table)}>{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border border-current/20 px-1.5 py-0.5 text-left font-medium">{children}</th>,
    td: ({ children }) => <td className="border border-current/20 px-1.5 py-0.5">{children}</td>,
  };
}

export const SupportMarkdown = memo(function SupportMarkdown({
  body,
  className,
  classes,
}: {
  body: string;
  className?: string;
  /** Référence stable (constante de module) : elle garde le rendu mémoïsé. */
  classes?: SupportMarkdownClasses;
}) {
  const components = useMemo(() => buildComponents(classes), [classes]);
  return (
    <div className={cn("space-y-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {body}
      </Markdown>
    </div>
  );
});
