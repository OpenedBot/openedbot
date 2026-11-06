import {
  Children,
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
// With its renderer, not in `main.tsx`: there it pulled KaTeX into the first load (ADR 0001, D1b).
import "katex/dist/katex.min.css";
import { AlertTriangle, Check, CircleAlert, Copy, Info, Lightbulb, ShieldAlert } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import {
  parseGithubAlertMarker,
  type GithubAlertType,
} from "../lib/stream/assistant-article-sections";
import { useT } from "../lib/i18n";
import { useMarkdownBlocks } from "../lib/stream/streaming-markdown";
import { rehypeStreamWords } from "../lib/stream/stream-tail-rehype";
import { itemsAfter, leadingText } from "../lib/stream/stream-word-text";
import type { ThemeRegistration } from "shiki";

/**
 * `remarkBreaks` : un simple retour à la ligne devient un `<br>`.
 *
 * En markdown strict, il n'en est pas un : il faut une ligne vide, ou deux
 * espaces en fin de ligne. C'est la règle d'un document ; ce fil n'en est pas
 * un. Un modèle qui écrit « 2. Extractibilité des réponses\nLes réponses
 * peuvent… » sépare délibérément un titre de son corps, et le rendu strict les
 * recollait en une phrase illisible : « Extractibilité des réponses Les
 * réponses peuvent… ». Mesuré sur une vraie réponse du runtime.
 *
 * C'est le réglage de toutes les surfaces de conversation, comme dans les
 * commentaires GitHub, ChatGPT et Claude, pour la même raison : dans un chat, l'auteur
 * voit ce qu'il tape, et un retour à la ligne y est une intention, pas un
 * accident de formatage.
 */
const remarkPlugins = [remarkGfm, remarkBreaks, remarkMath];
const rehypePlugins = [rehypeKatex];
/**
 * A block the stream writes or wrote: grok.com's word-by-word blur-in
 * (`rehypeStreamWords`). A block born in the stream keeps its word spans once
 * the stream ends, so the last words finish their blur instead of snapping.
 */
const streamWordsRehypePlugins = [rehypeKatex, rehypeStreamWords];

const ALERT_ICONS = {
  NOTE: Info,
  TIP: Lightbulb,
  IMPORTANT: CircleAlert,
  WARNING: AlertTriangle,
  CAUTION: ShieldAlert,
} as const;

const ALERT_CHROME: Record<GithubAlertType, string> = {
  NOTE: "border-border/70 bg-muted/40 text-foreground",
  TIP: "border-border/70 bg-muted/40 text-foreground",
  IMPORTANT: "border-warn-700/40 bg-warn-soft text-warn-700",
  WARNING: "border-warn-700/40 bg-warn-soft text-warn-700",
  CAUTION: "border-neg-700/40 bg-neg-soft text-neg-700",
};

function reactText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return reactText(node.props.children);
  return "";
}

export function MarkdownCallout({
  type,
  title,
  children,
}: {
  type: GithubAlertType;
  title?: string;
  children: ReactNode;
}) {
  const { t } = useT();
  const Icon = ALERT_ICONS[type];
  const fallback = t(
    type === "NOTE"
      ? "threadTimeline.alertNote"
      : type === "TIP"
        ? "threadTimeline.alertTip"
        : type === "IMPORTANT"
          ? "threadTimeline.alertImportant"
          : type === "WARNING"
            ? "threadTimeline.alertWarning"
            : "threadTimeline.alertCaution",
  );
  return (
    <aside
      data-callout={type}
      className={cn(
        "my-2 rounded-xl border border-l-[3px] px-3 py-2.5",
        ALERT_CHROME[type],
      )}
    >
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span>{title ?? fallback}</span>
      </p>
      <div className="text-sm text-foreground [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
        {children}
      </div>
    </aside>
  );
}

function Blockquote({ children }: { children?: ReactNode }) {
  // `react-markdown` intercale des nœuds texte `"\n"` entre les blocs : le
  // premier enfant n'est pas le paragraphe mais ce retour à la ligne, et le
  // marqueur `[!NOTE]` n'était jamais vu dès que l'encart avait un corps.
  const items = Children.toArray(children).filter(
    (item) => !(typeof item === "string" && !item.trim()),
  );
  const first = items[0];
  const firstText = reactText(first).trim();
  const firstLine = firstText.split("\n")[0] ?? "";
  const marker = parseGithubAlertMarker(firstLine);
  if (!marker) {
    return (
      <blockquote className="my-2 border-l-2 border-border/70 pl-3 text-muted-foreground">
        {children}
      </blockquote>
    );
  }
  const leftover = firstText.slice(firstLine.length).trim();
  const rest = leftover
    ? [<p key="leftover">{leftover}</p>, ...items.slice(1)]
    : items.slice(1);
  return (
    <MarkdownCallout type={marker.type} title={marker.title}>
      {rest}
    </MarkdownCallout>
  );
}

/**
 * Un arbre ASCII doit rester une grille : Markdown traite sinon les retours à
 * la ligne simples comme des espaces. Les glyphes de branches sont assez
 * spécifiques pour ne pas transformer une phrase ordinaire en bloc code.
 */
function looksLikeAsciiDiagram(text: string): boolean {
  const lines = text.split("\n");
  const treeLines = lines.filter((line) => /[├└┌┐┬┴│─]/u.test(line));
  const branchCount = text.match(/[├└┌┐]/gu)?.length ?? 0;
  return treeLines.length >= 2 || branchCount >= 2;
}

/**
 * Certains modèles renvoient un arbre « aplati » en séparant chaque branche
 * par un espace (`├── a ├── b`) au lieu d'un saut de ligne. On ne réécrit que
 * les séparateurs de branches, donc un vrai arbre multi-lignes reste inchangé.
 */
function normalizeAsciiDiagram(text: string): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const branchCount = line.match(/[├└]/gu)?.length ?? 0;
      return branchCount >= 2
        ? line.replace(/[ \t]+(?=(?:[│ ]*[├└]──))/gu, "\n").split("\n")
        : [line];
    })
    .join("\n");
}

/**
 * Une ligne qui n'est qu'un chemin : `src/`, `Domain/`, `src/Order/UI/Http/...`,
 * `tests/Unit/…`. Pas d'espace, au moins une barre, éventuellement une
 * ellipse finale.
 */
const PATH_LINE = /^[\w.@~-]+(?:\/[\w.@*~-]*)*\/?(?:\.{3}|…)?$/u;

/**
 * Une arborescence écrite SANS fence : le modèle liste ses dossiers ligne par
 * ligne (`src/`, `Shared/`, `Domain/`…). Rendue en prose, chaque ligne devenait
 * un paragraphe, et le découpage en cartes prenait `Application/` pour un
 * titre, mesuré sur une vraie réponse d'architecture Symfony. Deux chemins
 * consécutifs suffisent : une phrase ordinaire n'a jamais cette forme.
 */
export function looksLikePathListing(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  if (!lines.every((line) => PATH_LINE.test(line))) return false;
  return lines.filter((line) => line.includes("/")).length >= 2;
}

/**
 * « Principes techniques : », « Structure proposée : », « Pour la couche API,
 * je ferais ce choix : » : une ligne courte qui n'existe que pour annoncer ce
 * qui suit. Le modèle ne la balise pas ; en texte courant elle se noyait dans
 * les paragraphes (mesuré). Elle devient un intertitre : semi-gras, un peu
 * d'air au-dessus, sans changer d'élément.
 */
const INTRO_LINE = /^[^.!?\n]{3,90}[:：]$/u;

/**
 * « Domain : entités, value objects… » : un paragraphe qui commence par un
 * label court suivi de deux-points est une définition ; le label porte le
 * gras, le reste est la prose. Un à quatre mots, lettres et chiffres,
 * majuscule initiale : « POST /orders/{id}/confirm : … » ou « http://… » ne
 * matchent pas.
 */
const LEAD_LABEL = /^(\p{Lu}[\p{L}\p{N}'’-]*(?:[ \u00A0][\p{L}\p{N}'’-]+){0,3})([ \u00A0]?[:：][ \u00A0]+)(?=\S)/u;

/** Un connecteur seul (« Mais : », « Donc : ») n'est pas un label. */
const LABEL_CONNECTOR = /^(donc|ici|ainsi|ensuite|enfin|or|puis|mais|car|alors|soit|sauf|bref|so|then|but|also|however)$/iu;

export function isIntroLine(text: string): boolean {
  return INTRO_LINE.test(text.trim());
}

/** Coupe `Domain : suite` en `[label, séparateur, suite]`, ou `null`. */
export function splitLeadLabel(text: string): [string, string, string] | null {
  const match = text.match(LEAD_LABEL);
  if (!match) return null;
  const label = match[1]!;
  if (label.length > 40 || LABEL_CONNECTOR.test(label)) return null;
  return [label, match[2]!, text.slice(match[0].length)];
}

/**
 * « 1. Ce qui tient\nLes reference.md… » : une première ligne courte, sans
 * ponctuation finale, suivie d'un retour à la ligne, est le titre de ce qui
 * suit. Sans ça, seul un titre à deux-points passait en gras et les sections
 * d'une même réponse se lisaient de deux façons (mesuré).
 */
const TITLE_LINE_MAX = 80;

export function isTitleLine(text: string): boolean {
  const line = text.trim();
  return line.length > 0 && line.length <= TITLE_LINE_MAX && !/[.!?…;,]$/u.test(line);
}

/**
 * The overridden block components drop the hast `className`; the stream's
 * `openedbot-reveal` (`rehypeStreamWords`, on code) would never reach the DOM. This hands it to
 * the root element of whatever they render.
 */
function carryingClassName<Props extends { className?: string; children?: ReactNode }, Rendered>(
  Inner: (props: Props) => Rendered,
): (props: Props) => Rendered | ReactNode {
  return function ClassNameCarrier(props: Props) {
    const rendered = Inner(props);
    if (!props.className || !isValidElement<{ className?: string }>(rendered)) return rendered as ReactNode;
    return cloneElement(rendered, { className: cn(rendered.props.className, props.className) });
  };
}


function ParagraphBlock({ children }: { children?: ReactNode; className?: string }) {
  const text = reactText(children);
  // Un arbre ou un listing est du code : il prend la même carte que les blocs
  // fencés, entête et bouton Copier compris. Sans langage, `CodeBlock` reste
  // sur son rendu brut : une arborescence n'a aucune syntaxe à surligner.
  if (looksLikeAsciiDiagram(text)) {
    return <CodeBlock source={normalizeAsciiDiagram(text)} />;
  }
  if (looksLikePathListing(text)) {
    return (
      <CodeBlock
        listing
        source={text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n")}
      />
    );
  }
  if (isIntroLine(text)) {
    return (
      <p data-intro-line="" className="mt-4 mb-1 font-semibold text-foreground">
        {children}
      </p>
    );
  }
  // Le label n'est mis en gras que s'il est un texte nu en tête : un premier
  // enfant déjà balisé (lien, code, gras du modèle) est laissé tel quel. Les
  // mots d'un bloc écrit par le flux (`.grok-w`) se lisent comme ce texte nu.
  const items = Children.toArray(children);
  const lead = leadingText(items);
  if (!lead.count) return <p>{children}</p>;
  const next = items[lead.count];
  if (isValidElement(next) && next.type === "br" && isTitleLine(lead.text)) {
    return (
      <p>
        <strong data-lead-title="">{lead.text}</strong>
        {items.slice(lead.count)}
      </p>
    );
  }
  const split = splitLeadLabel(lead.text);
  if (split) {
    const [label, separator, rest] = split;
    return (
      <p>
        <strong data-lead-label="">{label}</strong>
        {separator}
        {itemsAfter(items, lead.text.length - rest.length)}
      </p>
    );
  }
  return <p>{children}</p>;
}

function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/:/gu, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            fontFamily: "Inter, sans-serif",
          },
        });
        return mermaid.render(`openedbot-mermaid-${id}`, source);
      })
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (failed || !svg) {
    return (
      <pre className="scrollbar-subtle not-prose my-2 max-w-full overflow-x-auto whitespace-pre rounded-lg border border-border/50 bg-surface-sunken/60 p-3 font-mono text-xs leading-5 text-foreground">
        {source}
      </pre>
    );
  }
  return (
    <div
      role="img"
      aria-label="Mermaid diagram"
      className="scrollbar-subtle not-prose my-2 max-w-full overflow-x-auto rounded-lg border border-border/50 bg-surface-sunken/60 p-3 text-foreground [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Vrai pendant le streaming de la réponse qui contient ce markdown. Le
 * surlignage attend la fermeture de la fence : le relancer à chaque fragment
 * reparcourait tout le bloc pour rien (21st.dev, « highlight when the fence
 * closes, not per token »).
 */
const MarkdownStreamingContext = createContext(false);

type ShikiHighlighter = (
  source: string,
  language: string,
) => Promise<string | null>;

let shikiPromise: Promise<ShikiHighlighter> | null = null;

/**
 * Le markdown d'un bloc de code, coloré comme chez Grok Bot (couleurs
 * calculées relevées le 30-10, converties d'OKLCH) : titres en rouge (clair)
 * ou turquoise (sombre) et en gras, `#` et puces à l'encre, texte des liens
 * et code en ligne en violet (rose), adresses en bleu, rien de souligné.
 * Ajoutées APRÈS les règles du thème GitHub : à portée égale, la dernière
 * gagne. Les autres langages gardent GitHub.
 */
type ThemeRule = { scope: string | string[]; settings: { foreground?: string; fontStyle?: string } };

const GROK_MARKDOWN = {
  light: { ink: "#141414eb", heading: "#b3003f", link: "#9e94d5", url: "#206595" },
  dark: { ink: "#d6d6dd", heading: "#82d2ce", link: "#e394dc", url: "#87c3ff" },
} as const;

export function withGrokMarkdown(theme: ThemeRegistration, mode: keyof typeof GROK_MARKDOWN): ThemeRegistration {
  const colors = GROK_MARKDOWN[mode];
  const rules: ThemeRule[] = [
    { scope: "text.html.markdown", settings: { foreground: colors.ink } },
    {
      scope: ["punctuation.definition.list.begin.markdown", "punctuation.definition.raw.markdown"],
      settings: { foreground: colors.ink, fontStyle: "" },
    },
    { scope: "markup.bold.markdown", settings: { foreground: colors.ink, fontStyle: "bold" } },
    { scope: "punctuation.definition.heading.markdown", settings: { foreground: colors.ink, fontStyle: "bold" } },
    { scope: "markup.heading.markdown entity.name.section.markdown", settings: { foreground: colors.heading, fontStyle: "bold" } },
    {
      scope: ["string.other.link.title.markdown", "string.other.link.description.markdown", "markup.inline.raw.string.markdown"],
      settings: { foreground: colors.link, fontStyle: "" },
    },
    { scope: "markup.underline.link.markdown", settings: { foreground: colors.url, fontStyle: "" } },
  ];
  return { ...theme, name: `${theme.name}-grok-markdown`, tokenColors: [...(theme.tokenColors ?? []), ...rules] };
}

/**
 * Shiki chargé à la demande, comme Mermaid : le bundle web ne pèse rien tant
 * qu'aucun bloc de code n'est affiché. Les deux thèmes GitHub, étendus du
 * markdown de Grok, s'émettent en variables CSS (`--shiki-light` /
 * `--shiki-dark`), et `globals.css` choisit la bonne selon `.dark`, sans
 * re-surlignage au changement de thème.
 */
function loadShiki(): Promise<ShikiHighlighter> {
  shikiPromise ??= Promise.all([import("shiki/bundle/web"), import("shiki/themes")]).then(
    async ([{ codeToHtml, bundledLanguages }, { bundledThemes }]) => {
      const [light, dark] = await Promise.all([bundledThemes["github-light"](), bundledThemes["github-dark"]()]);
      const themes = {
        light: withGrokMarkdown(light.default, "light"),
        dark: withGrokMarkdown(dark.default, "dark"),
      };
      return async (source, language) => {
        if (!(language in bundledLanguages)) return null;
        return codeToHtml(source, {
          lang: language,
          themes,
          defaultColor: false,
        });
      };
    },
  );
  return shikiPromise;
}

function useHighlightedCode(source: string, language: string | undefined): string | null {
  const streaming = useContext(MarkdownStreamingContext);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (streaming || !language) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void loadShiki()
      .then((highlight) => highlight(source, language))
      .then((rendered) => {
        if (!cancelled) setHtml(rendered);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [source, language, streaming]);
  return html;
}

/**
 * Un bloc de code, la carte de Grok Bot : pas d'entête, un bouton Copier
 * flottant en haut à droite. Le langage reste dit aux lecteurs d'écran
 * (`figcaption` masquée). Le bouton copie la SOURCE, pas le HTML surligné.
 */
export const CodeBlock = memo(function CodeBlock({
  language,
  source,
  listing = false,
}: {
  language?: string;
  source: string;
  /** Une arborescence promue depuis de la prose, pas une fence écrite par le modèle. */
  listing?: boolean;
}) {
  const { t } = useT();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const html = useHighlightedCode(source, language);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1_200);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(source);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <figure
      className="not-prose relative my-3 max-w-full overflow-hidden rounded-xl border text-foreground"
      data-code-block={language ?? ""}
    >
      <figcaption className="sr-only">{language ?? t("threadTimeline.codeBlockPlain")}</figcaption>
      <button
        type="button"
        data-code-copy=""
        onClick={() => void copy()}
        aria-label={copyState === "copied" ? t("threadTimeline.codeCopied") : t("threadTimeline.codeCopy")}
        title={copyState === "copied" ? t("threadTimeline.codeCopied") : t("threadTimeline.codeCopy")}
        className="absolute top-1.5 right-1.5 z-10 flex size-7 items-center justify-center rounded-lg border text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copyState === "copied"
          ? <Check className="size-3.5" aria-hidden />
          : <Copy className="size-3.5" aria-hidden />}
      </button>
      {html ? (
        <div
          className="scrollbar-subtle openedbot-code overflow-x-auto px-3.5 py-3 text-xs leading-5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          className="scrollbar-subtle m-0 overflow-x-auto whitespace-pre px-3.5 py-3 font-mono text-xs leading-5"
          data-path-listing={listing ? "" : undefined}
        >
          <code>{source}</code>
        </pre>
      )}
      {copyState === "error" ? (
        <span role="alert" className="sr-only">{t("threadTimeline.copyFailed")}</span>
      ) : null}
    </figure>
  );
});

const Code: NonNullable<Components["code"]> = ({ className, children, ...props }) => {
  return <code className={className} {...props}>{children}</code>;
};

const Pre: NonNullable<Components["pre"]> = ({ children }) => {
  const child = Children.toArray(children)[0];
  // `react-markdown` enveloppe chaque bloc fencé dans `<pre><code>` : on lit
  // le langage et la source sur le `<code>` et on rend notre propre bloc.
  if (isValidElement(child) && child.type === Code) {
    const props = child.props as { className?: string; children?: ReactNode };
    const language = /language-([\w-]+)/u.exec(props.className ?? "")?.[1];
    const source = String(reactText(props.children)).replace(/\n$/u, "");
    if (language === "mermaid") return <MermaidDiagram source={source} />;
    return <CodeBlock language={language} source={source} />;
  }
  return (
    <div className="scrollbar-subtle not-prose my-3 overflow-x-auto rounded-xl border border-border/60 bg-surface-sunken/60 p-3 text-foreground">
      <pre className="m-0 text-xs leading-5 text-foreground">{children}</pre>
    </div>
  );
};

/**
 * Un lien d'une réponse s'ouvre TOUJOURS dans un autre onglet. Le fil est une
 * application : suivre un lien dans la même vue quitte la conversation, et le
 * run en cours avec elle. `noreferrer` vaut aussi `noopener` : la page ouverte
 * n'apprend pas d'où elle vient et n'obtient aucune poignée sur la nôtre.
 *
 * Une ancre interne (`#…`) reste dans la page : l'ouvrir ailleurs rechargerait
 * l'app pour rien. `react-markdown` a déjà neutralisé les schémas d'URL qu'un
 * modèle n'a pas à faire cliquer (`javascript:`) avant d'arriver ici.
 */
const MarkdownLink: NonNullable<Components["a"]> = ({ href, title, children }) => {
  const anchor = typeof href === "string" && href.startsWith("#");
  return (
    <a
      href={href}
      title={title}
      {...(anchor ? {} : { target: "_blank", rel: "noreferrer noopener" })}
    >
      {children}
    </a>
  );
};

const Paragraph = carryingClassName(ParagraphBlock);

const wells: Pick<Components, "pre" | "table" | "a"> = {
  pre: carryingClassName(Pre),
  a: MarkdownLink,
  table: carryingClassName(({ children }: { children?: ReactNode; className?: string }) => (
    <div data-md-table="" className="scrollbar-subtle my-2 overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-sm">{children}</table>
    </div>
  )),
};

const proseComponents: Components = {
  ...wells,
  blockquote: carryingClassName(Blockquote),
  code: Code,
  p: Paragraph,
};

/**
 * The thread's markdown setup, for the dev thread lab (`/dev/thread-lab`),
 * which adds its own rehype step (text effects) on top of the same rendering.
 */
export const threadMarkdownSetup = { remarkPlugins, rehypePlugins, components: proseComponents } as const;

/**
 * Le markdown d'un DOCUMENT, comme les instructions d'un bot ou une pièce jointe
 * `.md`, par opposition à celui du fil. Il hérite des blocs de code (Shiki,
 * entête, bouton Copier), des tableaux et des encarts GitHub, mais d'aucune
 * heuristique de conversation : le `p` reste un `p`, sans intertitre deviné,
 * sans label mis en gras, sans listing promu. Un auteur qui relit son texte
 * doit y voir ce qu'il a écrit, pas ce qu'on a cru y lire.
 */
export const documentMarkdownComponents: Components = {
  ...wells,
  blockquote: Blockquote,
  code: Code,
};

const stepComponents: Components = {
  ...proseComponents,
  ol: ({ children }) => (
    <ol className="my-1 flex list-none flex-col gap-1.5 p-0 [counter-reset:openedbot-step]">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="flex items-start gap-2 rounded-lg bg-background/50 px-2.5 py-1.5 [counter-increment:openedbot-step]">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums text-muted-foreground before:content-[counter(openedbot-step)]" />
      <div className="min-w-0 flex-1 [&_p]:my-0">{children}</div>
    </li>
  ),
};

const FENCE = /^(```|~~~)/;
const SUMMARY_LEAD = /^(?:\*\*)?(en r[ée]sum[ée]|r[ée]sum[ée]|conclusion|in summary|summary|tl;dr|bottom line)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/iu;

/**
 * « En résumé : … » en dernier paragraphe devient un encart, comme un
 * `> [!NOTE] En résumé` écrit par le modèle. On ne touche qu'au DERNIER bloc
 * de prose, hors fence : un « résumé » au milieu d'un cours est une phrase,
 * pas une conclusion.
 */
export function promoteSummaryCallout(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  // Dernier paragraphe : de la dernière ligne non vide en remontant jusqu'à
  // une ligne vide, sans jamais entrer dans une fence ouverte.
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]!.trim()) end -= 1;
  if (end < 0) return markdown;
  let start = end;
  while (start > 0 && lines[start - 1]!.trim()) start -= 1;
  const first = lines[start]!;
  if (/^(\s*[>#|-]|\s*\d+\.\s|\s*[*+]\s|```|~~~)/.test(first)) return markdown;
  const fences = lines.slice(0, start).filter((line) => FENCE.test(line.trim())).length;
  if (fences % 2 === 1) return markdown;
  const match = first.match(SUMMARY_LEAD);
  if (!match) return markdown;
  const body = [first.slice(match[0].length), ...lines.slice(start + 1, end + 1)];
  if (!body.join("").trim()) return markdown;
  const title = match[1]!.replace(/^./u, (c) => c.toUpperCase());
  const callout = [`> [!NOTE] ${title}`, ...body.map((line) => `> ${line}`)];
  return [...lines.slice(0, start), ...callout, ...lines.slice(end + 1)].join("\n");
}

/** Un seul parse `react-markdown`, mémoïsé sur son texte. */
export const ThreadMarkdownBlock = memo(function ThreadMarkdownBlock({
  markdown,
  variant = "prose",
  tail = false,
  reveal = false,
}: {
  markdown: string;
  variant?: "prose" | "steps";
  /** The block the stream is writing: its new words blur in (`rehypeStreamWords`). */
  tail?: boolean;
  /** The block was mounted by the stream: it keeps its word spans, nothing replays. */
  reveal?: boolean;
}) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={tail || reveal ? streamWordsRehypePlugins : rehypePlugins}
      components={variant === "steps" ? stepComponents : proseComponents}
    >
      {markdown}
    </Markdown>
  );
});

/**
 * La réponse est rendue bloc par bloc (`useMarkdownBlocks`) : pendant le
 * flux, chaque mise à jour ne reparse que le dernier bloc, dont seuls les
 * mots nouveaux sortent du flou (`rehypeStreamWords`), les blocs déjà
 * terminés gardent leur texte et leur `memo`. Le `"\n"` entre deux blocs est
 * le nœud texte que `react-markdown` intercale entre deux blocs de premier
 * niveau : le DOM est celui d'un rendu d'un seul tenant. Même découpe hors
 * flux : à la fin du tour, seul le dernier bloc (résumé promu, fence
 * virtuelle retirée) se re-rend au lieu de toute la réponse.
 */
export function ThreadMarkdown({
  children,
  variant = "prose",
  streaming = false,
}: {
  children: string;
  variant?: "prose" | "steps";
  /** La réponse est encore en cours : pas de surlignage, pas de promotion de résumé. */
  streaming?: boolean;
}) {
  const markdown = streaming ? children : promoteSummaryCallout(children);
  const blocks = useMarkdownBlocks(markdown);
  // Blocks that exist when the stream is first seen (an answer opened
  // mid-run, a history reload) are not revealed; each block born after
  // that blurs in. Sticky: ending the stream must not cut a running reveal.
  const revealFrom = useRef<number | null>(null);
  if (revealFrom.current === null && streaming) revealFrom.current = blocks.length;
  return (
    <MarkdownStreamingContext.Provider value={streaming}>
      {blocks.map((block, index) => (
        <Fragment key={index}>
          {index > 0 ? "\n" : null}
          <ThreadMarkdownBlock
            markdown={block}
            variant={variant}
            tail={streaming && index === blocks.length - 1}
            reveal={revealFrom.current !== null && index >= revealFrom.current}
          />
        </Fragment>
      ))}
    </MarkdownStreamingContext.Provider>
  );
}
