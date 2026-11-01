export type ArticleSectionTone = "section" | "warning" | "method" | "exercise" | "answer";

export type GithubAlertType = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

export type ArticleSection = {
  heading: string;
  level: 2 | 3;
  tone: ArticleSectionTone;
  body: string;
  children: ArticleSection[];
};

export type ArticleDocument = {
  title: string | null;
  lead: string;
  sections: ArticleSection[];
};

const HEADING = /^(#{1,3})\s+(\S.*)$/;
const FENCE = /^(```|~~~)/;
const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.+))?$/i;
const NUMBERED_LINE = /^(\d+)\.\s+(.+)$/;
const LIST_MARK = /^[-*+]\s+/;
const CASE_WITH_BODY = /^(?:\*\*)?(si\b[^:*]+?)(?:\*\*)?\s*:\s+(.+)$/i;

const WARNING_RE = /(^|[^a-z])(erreur|erreurs|attention|piege|pieges|warning|caution|danger)([^a-z]|$)/;
const METHOD_RE = /(^|[^a-z])(resume|methode|methodes|etape|etapes|summary|step|steps|method)([^a-z]|$)/;
const EXERCISE_RE = /(^|[^a-z])(exercice|exercices|exercise|exercises|quiz|practice)([^a-z]|$)/;
/**
 * Le seul ton qui CACHE du contenu : il replie sa section dans un `<details>`
 * fermé. Il exige donc que le titre SOIT l'étiquette, pas qu'il la contienne.
 *
 * La version précédente cherchait le mot n'importe où dans le titre, et
 * repliait « 2. Extractibilité des réponses » : deux tiers d'une réponse de
 * modèle disparaissaient derrière un chevron, sans indice de ce qui manquait.
 * Le commentaire d'alors disait déjà l'intention : « Solutions au milieu d'un
 * exemple ≠ section spoiler », mais une recherche de sous-chaîne ne peut pas
 * la tenir. C'est le même raisonnement que `isBareSectionTitle` juste en
 * dessous, appliqué là où se cache le coût.
 *
 * Les trois autres tons ne masquent rien (encart, carte visible) : la
 * tolérance d'une sous-chaîne leur coûte au pire une bordure de trop.
 */
const ANSWER_TITLE_RE = /^(?:\d+[.)]\s*)?(reponses?|answers?|corriges?|corrections?)\s*[:：]?\s*$/;

function foldHeading(title: string): string {
  return title.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function toneFromHeading(title: string): ArticleSectionTone {
  const text = foldHeading(title.trim());
  if (!text) return "section";
  if (WARNING_RE.test(text)) return "warning";
  if (ANSWER_TITLE_RE.test(text)) return "answer";
  if (EXERCISE_RE.test(text)) return "exercise";
  if (METHOD_RE.test(text)) return "method";
  return "section";
}

export function parseGithubAlertMarker(firstLine: string): {
  type: GithubAlertType;
  title?: string;
} | null {
  const match = firstLine.trim().match(ALERT_MARKER);
  if (!match) return null;
  const type = match[1]!.toUpperCase() as GithubAlertType;
  const title = match[2]?.trim() || undefined;
  return title ? { type, title } : { type };
}

/** `blockquote` markdown (`> …`) ou le premier ligne déjà dépouillée. */
function stripTitleDecor(line: string): string {
  return line
    .trim()
    .replace(/^\*\*(.+?)\*\*$/, "$1")
    .replace(/[:：]\s*$/, "")
    .trim();
}

function looksLikeEquation(text: string): boolean {
  return /=/.test(text) && /[\dxyzΔδ√]/.test(text);
}

function isDeltaCase(text: string): boolean {
  const folded = foldHeading(text);
  return /\bsi\s*(delta|[δΔ])\b/.test(folded) || /\bsi\s+.+\s*([<>]=?|=)\s*0\b/.test(folded);
}

/** Ligne entière = label de section, pas une phrase qui contient le mot. */
function isBareSectionTitle(title: string): boolean {
  return /^(?:\d+\.\s*)?(erreurs?(?:\s+frequentes?)?|resume(?:\s+a\s+retenir)?|methodes?(?:\s+generale|\s+en\s+\d+\s+etapes?)?|exercices?|reponses?|answers?|summary|steps?|attention|definition)\s*$/
    .test(foldHeading(title));
}

const STEP_TITLE = /^(etape|étape|step)\s+\d+\b/;
const CASE_NUM = /^cas\s+\d+\b/;
const STRONG_TITLE = /^(definition|discriminant|methode|exemple|cas\s+particulier|forme|interpretation|somme|tableau|resoudre|cours|lecon|chapitre|introduction|conclusion|rappel|propriete|theoreme|demonstration|application|remarque)\b/;
const TITLE_CONNECTOR = /^(donc|ici|ainsi|ensuite|enfin|or|puis|mais|car|alors|soit|sauf|avec|pour|dans|sur|comme|si)\b/;
const TITLE_VERB = /\b(sont|est|ont|avoir|faire|peut|peuvent|doit|doivent|s'appelle|possede|indique|correspond)\b/;

function isStepTitle(text: string): boolean {
  return STEP_TITLE.test(foldHeading(text));
}

function isNumberedCase(text: string): boolean {
  return CASE_NUM.test(foldHeading(text));
}

function isCourseTitle(text: string): boolean {
  return /^(cours|course|lecon|lesson|chapitre|chapter)\b/.test(foldHeading(text));
}

/** Titre de card Grok-like : `Définition`, `Le discriminant`, `Exemple avec une seule solution`. */
export function looksLikeStandaloneTitle(line: string): boolean {
  const title = stripTitleDecor(line.replace(/^\*\*(.+?)\*\*$/, "$1"));
  if (title.length < 2 || title.length > 70) return false;
  if (LIST_MARK.test(line) || looksLikeEquation(title)) return false;
  if (/[.!?]$/.test(title)) return false;
  if (!/^[\p{Lu}\d]/u.test(title)) return false;
  const folded = foldHeading(title);
  if (TITLE_CONNECTOR.test(folded)) return false;
  if (TITLE_VERB.test(folded)) return false;
  if (isBareSectionTitle(title) || STRONG_TITLE.test(folded)) return true;
  return /^(le|la|les|un|une)\s+\S/.test(folded) && title.split(/\s+/).length <= 6;
}

/** Titre implicite du modèle (sans `#`) : `12. Erreurs fréquentes`, `Définition`, `Si Δ > 0`. */
export function matchImplicitHeading(
  line: string,
  hasParent: boolean,
): { level: 2 | 3; heading: string; body: string } | null {
  const raw = line.trim();
  if (!raw || LIST_MARK.test(raw)) return null;

  const withBody = raw.match(CASE_WITH_BODY);
  if (withBody && hasParent && isDeltaCase(withBody[1]!)) {
    return { level: 3, heading: withBody[1]!.trim(), body: withBody[2]!.trim() };
  }
  if (hasParent && isDeltaCase(raw) && raw.length <= 80) {
    return { level: 3, heading: stripTitleDecor(raw), body: "" };
  }
  if (hasParent && isNumberedCase(raw) && raw.length <= 80) {
    return { level: 3, heading: stripTitleDecor(raw), body: "" };
  }
  if (hasParent && isStepTitle(raw) && raw.length <= 80) {
    return { level: 3, heading: stripTitleDecor(raw), body: "" };
  }

  const numbered = raw.match(NUMBERED_LINE);
  if (numbered) {
    const rest = stripTitleDecor(numbered[2]!);
    if (looksLikeEquation(rest) || toneFromHeading(rest) === "section") return null;
    return { level: 2, heading: `${numbered[1]}. ${rest}`, body: "" };
  }

  const title = stripTitleDecor(raw.replace(/^\*\*(.+?)\*\*$/, "$1"));
  if (!isBareSectionTitle(title) && !looksLikeStandaloneTitle(raw)) return null;
  return { level: 2, heading: title, body: "" };
}

export function isGithubAlert(blockquote: string): boolean {
  const first = blockquote
    .replace(/^\s*>\s?/gm, "")
    .trim()
    .split("\n")[0] ?? "";
  return parseGithubAlertMarker(first) !== null;
}

export function splitArticleSections(markdown: string): ArticleDocument {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let title: string | null = null;
  const lead: string[] = [];
  const sections: ArticleSection[] = [];
  let current: ArticleSection | null = null;
  let child: ArticleSection | null = null;
  let inFence = false;

  const flushChild = () => {
    if (!child || !current) return;
    child.body = child.body.replace(/^\n+|\n+$/g, "");
    current.children.push(child);
    child = null;
  };

  const flushSection = () => {
    flushChild();
    if (!current) return;
    current.body = current.body.replace(/^\n+|\n+$/g, "");
    sections.push(current);
    current = null;
  };

  const append = (line: string) => {
    if (child) {
      child.body = child.body ? `${child.body}\n${line}` : line;
      return;
    }
    if (current) {
      current.body = current.body ? `${current.body}\n${line}` : line;
      return;
    }
    lead.push(line);
  };

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence) {
      if (
        title === null
        && sections.length === 0
        && current === null
        && lead.every((entry) => !entry.trim())
        && isCourseTitle(line.trim())
        && looksLikeStandaloneTitle(line)
      ) {
        title = stripTitleDecor(line.replace(/^\*\*(.+?)\*\*$/, "$1"));
        continue;
      }
      const heading = line.match(HEADING);
      if (heading) {
        const level = heading[1]!.length;
        const text = heading[2]!.trim();
        if (level === 1 && title === null && sections.length === 0 && current === null) {
          title = text;
          continue;
        }
        if (level === 3 && current) {
          flushChild();
          child = { heading: text, level: 3, tone: toneFromHeading(text), body: "", children: [] };
          continue;
        }
        flushSection();
        current = {
          heading: text,
          level: level === 3 ? 3 : 2,
          tone: toneFromHeading(text),
          body: "",
          children: [],
        };
        continue;
      }
      const implicit = matchImplicitHeading(line, current !== null);
      if (implicit) {
        if (implicit.level === 3 && current) {
          flushChild();
          child = {
            heading: implicit.heading,
            level: 3,
            tone: toneFromHeading(implicit.heading),
            body: implicit.body,
            children: [],
          };
          continue;
        }
        if (implicit.level === 2) {
          flushSection();
          current = {
            heading: implicit.heading,
            level: 2,
            tone: toneFromHeading(implicit.heading),
            body: implicit.body,
            children: [],
          };
          continue;
        }
      }
    }
    append(line);
  }

  flushSection();
  return {
    title,
    lead: lead.join("\n").replace(/^\n+|\n+$/g, ""),
    sections,
  };
}

export type AssistantCardTone = ArticleSectionTone | "lead";

export type AssistantCard = {
  id: string;
  title: string | null;
  markdown: string;
  tone: AssistantCardTone;
};

function sectionToMarkdown(section: ArticleSection): string {
  const mark = section.level === 3 ? "###" : "##";
  const parts = [`${mark} ${section.heading}`];
  if (section.body.trim()) parts.push(section.body.trim());
  for (const child of section.children) parts.push(sectionToMarkdown(child));
  return parts.join("\n\n");
}

/**
 * Aplatit un cours en cards hoverables (une par H2 / titre implicite).
 * Le titre du document n'est pas une card : il se pose au-dessus de la pile.
 */
export function splitAssistantCards(markdown: string): {
  title: string | null;
  cards: AssistantCard[];
} {
  const doc = splitArticleSections(markdown);
  const cards: AssistantCard[] = [];
  if (doc.lead.trim()) {
    cards.push({ id: "lead", title: null, markdown: doc.lead.trim(), tone: "lead" });
  }
  for (const [index, section] of doc.sections.entries()) {
    cards.push({
      id: `s${index}`,
      title: section.heading,
      markdown: sectionToMarkdown(section),
      tone: section.tone,
    });
  }
  if (cards.length === 0 && markdown.trim()) {
    cards.push({ id: "body", title: null, markdown: markdown.trim(), tone: "lead" });
  }
  return { title: doc.title, cards };
}
