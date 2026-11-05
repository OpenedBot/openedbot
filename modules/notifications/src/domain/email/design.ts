/**
 * Le langage visuel des e-mails d'openedbot : une carte de la console, posée sur
 * son fond.
 *
 * Le modèle est double. BoardUI, le gabarit que la console clone, donne les
 * VALEURS : fond `#f7f7f7`, carte blanche à filet `#ebebeb` et coins de
 * 20 px, panneaux `#f7f7f7` à 12 px, encre `#0a0a0a`, gris `#737373`, bouton
 * dégradé de l'accent. Les meilleurs courriers transactionnels (Linear,
 * Vercel, Raycast) donnent la RETENUE : une colonne étroite de 520 px, un
 * petit logo, un titre sobre en sans-serif, un seul élément en couleur (le
 * bouton), le code à recopier en grand, et un pied pâle hors de la carte.
 *
 * Un message se lit donc de haut en bas : le logo, le titre, une ou deux
 * phrases, l'objet du message (code, détails ou bouton), une note grise. Rien
 * d'autre ne réclame l'œil.
 *
 * **Le mode sombre est explicitement refusé**, et c'est une décision, pas un
 * oubli. `color-scheme: light` et `supported-color-schemes: light` disent au
 * client de ne PAS inverser les couleurs : sans eux, Apple Mail et Outlook
 * retournent le message tout seuls et rendent un fond noir que personne n'a
 * dessiné.
 *
 * ---
 *
 * UN message se déclare en BLOCS (`EmailBlock`), une seule fois. Le HTML et le
 * texte brut sont ensuite DÉRIVÉS de cette même liste : c'est ce qui empêche
 * les deux versions de diverger.
 *
 * ---
 *
 * Les contraintes du courrier, qui expliquent chaque bizarrerie du HTML
 * ci-dessous, et qui ne sont pas négociables :
 *
 * - **Des tableaux, pas de flex ni de grid.** Outlook rend le HTML avec le
 *   moteur de Word. Chaque bloc est une ligne d'un tableau,
 *   `role="presentation"` pour que les lecteurs d'écran ne l'annoncent pas.
 * - **Styles en ligne.** Gmail retire une partie de ce qui vit dans `<style>`,
 *   qui ne garde que la requête média du téléphone.
 * - **Les coins arrondis n'existent pas dans Outlook.** La carte et les panneaux y
 *   deviennent des rectangles, ce qui reste lisible ; le bouton, lui, garde
 *   ses coins par un `v:roundrect` VML que seul Outlook lit.
 * - **Le texte de prévisualisation** est un bloc caché en tête de corps,
 *   rembourré de caractères invisibles.
 *
 * Le HTML produit est INDENTÉ, une balise de structure par ligne : un e-mail
 * se relit dans le « HTML Source » d'un client de test.
 */

export type EmailBlock =
  /**
   * Une image pleine largeur, en tête de message. `width` et `height` sont les
   * dimensions AFFICHÉES, pas celles du fichier : le fichier fait le double
   * pour les écrans à forte densité. Les deux sont posées en ATTRIBUTS, sans
   * quoi le client ne réserve pas la place et le texte saute quand l'image
   * arrive. `alt` vide pour une image décorative.
   */
  | { kind: "image"; url: string; alt: string; width: number; height: number }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "note"; text: string }
  | { kind: "button"; label: string; url: string }
  /** Des détails clé/valeur, posés dans un panneau gris. */
  | { kind: "rows"; rows: ReadonlyArray<readonly [string, string]> }
  /**
   * Un code à recopier (connexion, vérification), en grand dans un panneau gris.
   * `label` le nomme pour la version texte et pour les lecteurs d'écran.
   */
  | { kind: "code"; label: string; code: string }
  | { kind: "divider" };

export type EmailDocument = {
  /** Langue du document, portée par `<html lang>` et par la ligne de signature. */
  locale: "fr" | "en";
  /** Objet du message ; sert aussi de `<title>`. */
  subject: string;
  /** La ligne que la liste de messages montre après l'objet. */
  preheader: string;
  blocks: readonly EmailBlock[];
  /** Pourquoi cette personne reçoit ce message. Une phrase, sous le filet. */
  footerReason: string;
  /** Liens légaux du pied de page, quand le producteur connaît l'origine. */
  footerLinks?: ReadonlyArray<readonly [string, string]>;
};

/**
 * Les valeurs de BoardUI en clair (`apps/console/src/styles/components/boardui.css`,
 * `browser/ui-kit/src/styles/app.css`) : le fond secondaire `#f7f7f7`, la
 * carte blanche, ses filets `#ebebeb`, l'encre `#0a0a0a`, le gris secondaire
 * `#737373`, et le dégradé du bouton principal de la console (accent 500 vers
 * 600). Un e-mail ne lit pas de variable CSS : les teintes sont recopiées.
 */
export const EMAIL_COLORS = {
  page: "#f7f7f7",
  card: "#ffffff",
  cardEdge: "#ebebeb",
  ink: "#0a0a0a",
  body: "#404040",
  dim: "#737373",
  faint: "#a3a3a3",
  line: "#ebebeb",
  panel: "#f7f7f7",
  action: "#155dfc",
  actionTop: "#3080ff",
  onAction: "#ffffff",
  link: "#155dfc",
} as const;

/** Inter quand il est installé (c'est la police de la console), la pile système sinon. */
const FONT_STACK =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** La largeur des meilleurs courriers transactionnels : une colonne de lecture, pas une page. */
const CONTENT_WIDTH = 520;

/**
 * Le logo, en PNG (Outlook ne lit pas WebP), dans `public/email/` de la
 * console : une URL que Vite ne hache pas, donc valable pour toujours dans les
 * boîtes déjà servies. Le fichier fait trois fois la taille affichée.
 */
export const EMAIL_BRAND_MARK_URL = "https://openedbot.app/email/openedbot-mark.png";

/** La signature du pied de page, dans la langue du message. */
const SIGNATURE: Record<EmailDocument["locale"], string> = {
  fr: "openedbot, la console dans votre navigateur, le bot sur votre serveur.",
  en: "openedbot, the console in your browser, the bot on your server.",
};

export function renderEmailHtml(document: EmailDocument): string {
  const lines = [
    "<!DOCTYPE html>",
    `<html lang="${document.locale}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">`,
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    // Sans elle, iOS Mail « aide » en redimensionnant le texte tout seul.
    '  <meta name="x-apple-disable-message-reformatting" />',
    // Les deux lignes qui interdisent au client d'inverser les couleurs.
    '  <meta name="color-scheme" content="light" />',
    '  <meta name="supported-color-schemes" content="light" />',
    `  <title>${escapeHtml(document.subject)}</title>`,
    "  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->",
    "  <style>",
    ...styleSheet().map((rule) => `    ${rule}`),
    "  </style>",
    "</head>",
    `<body style="margin:0;padding:0;width:100%;background-color:${EMAIL_COLORS.page};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%;">`,
    `  ${preheaderHtml(document.preheader)}`,
    `  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.page};">`,
    "    <tr>",
    '      <td align="center" style="padding:48px 16px 40px 16px;" class="openedbot-outer">',
    `        <table role="presentation" width="${CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${CONTENT_WIDTH}px;text-align:left;">`,
    "          <tr>",
    // La carte : le panneau blanc de BoardUI, filet clair, coins de 20 px.
    `            <td style="background-color:${EMAIL_COLORS.card};border:1px solid ${EMAIL_COLORS.cardEdge};border-radius:20px;padding:40px 40px 32px 40px;" class="openedbot-card">`,
    `              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
    ...brandHtml().map(indent(16)),
    ...document.blocks.flatMap((block) => renderBlockHtml(block)).map(indent(16)),
    "              </table>",
    "            </td>",
    "          </tr>",
    ...footerHtml(document).map(indent(10)),
    "        </table>",
    "      </td>",
    "    </tr>",
    "  </table>",
    "</body>",
    "</html>",
  ];
  return lines.join("\n");
}

/**
 * La même liste de blocs, en texte brut. Un client qui refuse le HTML lit
 * exactement le même message, sans balise et sans mise en page à deviner.
 */
export function renderEmailText(document: EmailDocument): string {
  const body = document.blocks
    .map((block) => renderBlockText(block))
    .filter((part) => part.length > 0)
    .join("\n\n");
  const links = (document.footerLinks ?? []).map(([label, url]) => `${label} : ${url}`).join("\n");
  return [body, document.footerReason, links].filter((part) => part.length > 0).join("\n\n");
}

function indent(spaces: number): (line: string) => string {
  const pad = " ".repeat(spaces);
  return (line) => `${pad}${line}`;
}

/**
 * Le logo seul, 40 px, en haut à gauche de la carte. Pas de nom à côté :
 * l'expéditeur s'appelle déjà openedbot dans la liste des messages, et le pied de
 * page le redit en texte. `alt` porte le nom pour un client qui bloque les
 * images.
 */
function brandHtml(): string[] {
  return row(
    `<img src="${EMAIL_BRAND_MARK_URL}" width="40" height="40" alt="openedbot" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;color:${EMAIL_COLORS.ink};font-family:${FONT_STACK};font-size:14px;font-weight:600;" />`,
    "0 0 28px 0",
  );
}

function renderBlockHtml(block: EmailBlock): string[] {
  switch (block.kind) {
    case "image":
      // `display:block` : sans lui le client garde la ligne de base d'un
      // caractère sous l'image, et un liseré blanc apparaît sous le bandeau.
      return row(
        `<img src="${safeUrl(block.url)}" width="${block.width}" height="${block.height}" alt="${escapeHtml(block.alt)}" style="display:block;width:100%;max-width:${block.width}px;height:auto;border:0;border-radius:12px;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />`,
        "0 0 28px 0",
      );
    case "heading":
      return row(
        `<h1 style="margin:0;padding:0;color:${EMAIL_COLORS.ink};font-family:${FONT_STACK};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.02em;" class="openedbot-h1">${escapeHtml(block.text)}</h1>`,
        "0 0 12px 0",
      );
    case "paragraph":
      return row(
        `<p style="margin:0;padding:0;color:${EMAIL_COLORS.body};font-family:${FONT_STACK};font-size:15px;line-height:1.6;">${escapeHtml(block.text)}</p>`,
        "0 0 14px 0",
      );
    case "note":
      return row(
        `<p style="margin:0;padding:0;color:${EMAIL_COLORS.dim};font-family:${FONT_STACK};font-size:13px;line-height:1.55;">${escapeHtml(block.text)}</p>`,
        "0 0 12px 0",
      );
    case "divider":
      return ruleHtml("12px 0 20px 0");
    case "button":
      return row(buttonHtml(block.label, block.url), "10px 0 22px 0");
    case "rows":
      return rowsHtml(block.rows);
    case "code":
      return codeHtml(block.label, block.code);
  }
}

function renderBlockText(block: EmailBlock): string {
  switch (block.kind) {
    case "image":
      // La version texte porte le MESSAGE ; l'image n'en dit pas un mot de plus.
      return "";
    case "heading":
    case "paragraph":
    case "note":
      return block.text;
    case "divider":
      return "";
    case "button":
      return `${block.label} : ${block.url}`;
    case "rows":
      return block.rows.map(([key, value]) => `${key} : ${value}`).join("\n");
    case "code":
      return `${block.label} : ${block.code}`;
  }
}

function row(content: string, padding: string): string[] {
  return ["<tr>", `  <td style="padding:${padding};">${content}</td>`, "</tr>"];
}

/** Le filet : une cellule d'un pixel, pas un `<hr>` que chaque client stylise à sa façon. */
function ruleHtml(padding: string): string[] {
  return row(
    `<div style="height:1px;line-height:1px;font-size:0;background-color:${EMAIL_COLORS.line};">&nbsp;</div>`,
    padding,
  );
}

/**
 * Le bouton principal de la console : dégradé de l'accent 500 vers 600, coins
 * de 10 px, libellé de 15 px en medium. `background-color` reste le repli des
 * clients qui retirent `background-image` (Gmail, Outlook) ; `v:roundrect`
 * porte les coins dans Outlook, à une largeur estimée sur le libellé.
 */
function buttonHtml(label: string, url: string): string {
  const href = safeUrl(url);
  const width = Math.min(420, Math.max(160, label.length * 8 + 48));
  return [
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:${width}px;" arcsize="23%" stroke="f" fillcolor="${EMAIL_COLORS.action}"><w:anchorlock/><center style="color:${EMAIL_COLORS.onAction};font-family:${FONT_STACK};font-size:15px;font-weight:500;">${escapeHtml(label)}</center></v:roundrect><![endif]-->`,
    "<!--[if !mso]><!-->",
    `<a href="${href}" style="display:inline-block;background-color:${EMAIL_COLORS.action};background-image:linear-gradient(180deg,${EMAIL_COLORS.actionTop} 0%,${EMAIL_COLORS.action} 100%);color:${EMAIL_COLORS.onAction};font-family:${FONT_STACK};font-size:15px;line-height:20px;font-weight:500;text-decoration:none;padding:12px 20px;border-radius:10px;box-shadow:0 1px 2px 0 rgba(10,10,10,0.08);">${escapeHtml(label)}</a>`,
    "<!--<![endif]-->",
  ].join("");
}

/**
 * Les détails clé/valeur : un panneau `#f7f7f7` à coins de 12 px, comme une
 * ligne de réglages de la console. Libellé gris à gauche, valeur en encre à
 * droite, un filet clair entre chacune.
 */
function rowsHtml(rows: ReadonlyArray<readonly [string, string]>): string[] {
  const cells = rows.flatMap(([key, value], index) => {
    const border = index < rows.length - 1 ? `border-bottom:1px solid ${EMAIL_COLORS.line};` : "";
    return [
      "<tr>",
      `  <td width="42%" valign="top" style="padding:12px 12px 12px 0;${border}color:${EMAIL_COLORS.dim};font-family:${FONT_STACK};font-size:14px;line-height:1.45;">${escapeHtml(key)}</td>`,
      `  <td align="right" valign="top" style="padding:12px 0;${border}color:${EMAIL_COLORS.ink};font-family:${FONT_STACK};font-size:14px;line-height:1.45;font-weight:500;word-break:break-word;">${escapeHtml(value)}</td>`,
      "</tr>",
    ];
  });
  return panelHtml(cells, "4px 18px");
}

/**
 * Le code : la seule chose que la personne doit recopier, centré dans le
 * panneau, en grand, chiffres tabulaires et lettres espacées pour qu'on le
 * lise sans compter.
 */
function codeHtml(label: string, code: string): string[] {
  return panelHtml(
    [
      "<tr>",
      `  <td align="center" style="padding:0;color:${EMAIL_COLORS.ink};font-family:${FONT_STACK};font-size:34px;line-height:1.15;font-weight:600;letter-spacing:0.28em;font-variant-numeric:tabular-nums;" class="openedbot-code" aria-label="${escapeHtml(label)}">${escapeHtml(code)}</td>`,
      "</tr>",
    ],
    "24px 18px 24px 26px",
  );
}

function panelHtml(inner: string[], padding: string): string[] {
  return [
    "<tr>",
    '  <td style="padding:6px 0 22px 0;">',
    `    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.panel};border-radius:12px;">`,
    "      <tr>",
    `        <td style="padding:${padding};">`,
    '          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    ...inner.map(indent(12)),
    "          </table>",
    "        </td>",
    "      </tr>",
    "    </table>",
    "  </td>",
    "</tr>",
  ];
}

/**
 * Le pied, HORS de la carte, sur le gris : la raison de l'envoi, puis la
 * signature, puis les liens s'il y en a. Petit et pâle, comme chez Linear ou
 * Vercel : il ne concurrence pas le message.
 */
function footerHtml(document: EmailDocument): string[] {
  const links = (document.footerLinks ?? [])
    .map(([label, url]) =>
      `<a href="${safeUrl(url)}" style="color:${EMAIL_COLORS.dim};text-decoration:underline;">${escapeHtml(label)}</a>`)
    .join(`<span style="color:${EMAIL_COLORS.faint};">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);
  return [
    "<tr>",
    `  <td style="padding:20px 40px 0 40px;color:${EMAIL_COLORS.dim};font-family:${FONT_STACK};font-size:12px;line-height:1.6;" class="openedbot-foot">${escapeHtml(document.footerReason)}</td>`,
    "</tr>",
    "<tr>",
    `  <td style="padding:6px 40px 0 40px;color:${EMAIL_COLORS.faint};font-family:${FONT_STACK};font-size:12px;line-height:1.6;" class="openedbot-foot">${escapeHtml(SIGNATURE[document.locale])}${links ? `<br />${links}` : ""}</td>`,
    "</tr>",
  ];
}

function preheaderHtml(preheader: string): string {
  // Le rembourrage : espace chiffre, indicateur d'ordre des octets et diacritique
  // sans effet, répétés. Invisibles, ils occupent la place que le client aurait
  // remplie avec le début du message.
  const padding = "&#847;&zwnj;&nbsp;&#8199;&#65279;".repeat(24);
  return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:transparent;mso-hide:all;">${escapeHtml(preheader)}${padding}</div>`;
}

/**
 * `<style>` ne porte QUE ce qui ne peut pas vivre en ligne : la déclaration de
 * schéma clair, et la respiration du téléphone.
 */
function styleSheet(): string[] {
  return [
    ":root{color-scheme:light;supported-color-schemes:light;}",
    "body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}",
    "table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}",
    "table{border-collapse:separate;}",
    "img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}",
    "@media only screen and (max-width:560px){",
    "  .openedbot-outer{padding:20px 10px 28px 10px!important;}",
    "  .openedbot-card{padding:28px 22px 22px 22px!important;border-radius:16px!important;}",
    "  .openedbot-foot{padding-left:22px!important;padding-right:22px!important;}",
    "  .openedbot-h1{font-size:20px!important;}",
    "  .openedbot-code{font-size:28px!important;letter-spacing:0.2em!important;}",
    "}",
  ];
}

/**
 * Un `href` ne sort d'ici qu'en `http`/`https`. Une URL absente ou d'un autre
 * schéma (`javascript:`, `data:`) devient `#` : un bouton mort vaut mieux
 * qu'un lien que le message n'a pas voulu.
 */
export function safeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "#";
    return escapeHtml(parsed.href);
  } catch {
    return "#";
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
