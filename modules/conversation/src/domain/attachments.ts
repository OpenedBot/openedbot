/**
 * Les pièces jointes d'un message (US-CHAT-08), du composer jusqu'au prompt.
 *
 * Un document atteint le modèle dans la chaîne `input` de `POST /v1/runs`, et
 * ce fichier est l'endroit unique où l'on décide comment il s'y écrit. Une
 * image n'y laisse que son nom : ses octets partent en part `image_url` du
 * run (`hermesRunRequestBody`), relus du magasin par le worker. Les deux
 * clients produisent la même forme
 * parce qu'ils utilisent les mêmes adaptateurs (`CompositeAttachmentAdapter`
 * d'assistant-ui) : un texte arrive déjà emballé dans `<attachment name=…>`,
 * une image arrive en data-URI base64.
 *
 * Le fichier RESTE dans le message : `attachmentPayload` rend les octets que
 * le cloud API range dans `message_attachments`, et la part `attachment` du
 * message ne porte que leur identité plus un `id`. Le fil rouvert des semaines
 * plus tard réaffiche donc la pièce, tandis que la lecture d'un fil ne
 * transporte pas le poids des images qu'il contient, c'est la route
 * `GET /api/attachments/:id` qui les sert, à la demande.
 */

import type { MessageContent } from "@openedbot/contracts-api";

/**
 * `image` et `document` sont les deux seuls types que nos adaptateurs
 * produisent (`SimpleImageAttachmentAdapter` → `image`,
 * `SimpleTextAttachmentAdapter` → `document`). assistant-ui en connaît un
 * troisième (`file`), que nous n'émettons pas : accepter un binaire quelconque
 * reviendrait à le pousser dans le prompt sans que rien ne sache le lire.
 */
export type AttachmentKind = "image" | "document";

/** Les parts qu'un adaptateur assistant-ui rend dans `CompleteAttachment.content`. */
export type AttachmentContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string };

/**
 * Ce qu'un client envoie au cloud API : une `CompleteAttachment` d'assistant-ui
 * moins ce qui ne traverse pas le réseau (`file`, `status`).
 */
export type MessageAttachmentInput = {
  name: string;
  contentType: string;
  kind: AttachmentKind;
  content: AttachmentContentPart[];
};

/**
 * Les bornes, nommées ici et appliquées côté serveur (le client les affiche,
 * il ne les garantit pas).
 *
 * Ce n'est PAS la taille du corps HTTP qui les fixe, c'est la fenêtre de
 * contexte : une pièce voyage inlinée dans `input`, donc en base64 pour une
 * image : ~4/3 d'octets, et environ un jeton pour quatre caractères. 1 Mio
 * d'image, c'est déjà ~350 000 jetons, plus que la fenêtre entière du plus
 * petit modèle courant (131 072 pour Hermes 4). D'où
 * le plafond bas ET la réduction d'image côté client, sans laquelle une photo
 * de téléphone serait refusée d'office. Cinq pièces, parce qu'au-delà on ne
 * joint plus un contexte, on téléverse un dossier.
 */
export const ATTACHMENT_LIMITS = {
  maxCount: 5,
  maxBytesEach: 1024 * 1024,
  maxBytesTotal: 3 * 1024 * 1024,
} as const;

/**
 * Le plus grand côté d'une image après réduction, et la qualité JPEG visée.
 *
 * 1568 px est la borne au-delà de laquelle les fournisseurs de vision
 * redimensionnent de toute façon : envoyer plus, c'est payer des jetons pour
 * des pixels que personne ne regarde.
 */
export const IMAGE_DOWNSCALE = { maxEdge: 1568, quality: 0.82 } as const;

/** Ce que les adaptateurs acceptent, dans la syntaxe d'un `accept` HTML. */
export const ATTACHMENT_ACCEPT =
  "image/*,text/plain,text/markdown,text/csv,text/html,text/xml,text/css,application/json,.md,.txt,.csv,.json,.log,.ts,.tsx,.js,.jsx,.py,.rs,.go,.sql,.yaml,.yml,.toml";

/**
 * Le poids réel de la pièce, pas celui de son encodage.
 *
 * Un data-URI base64 pèse ~4/3 de l'octet qu'il décrit : afficher sa longueur
 * de chaîne annoncerait « 1,3 Mo » pour une image de 1 Mo, et le plafond
 * refuserait des fichiers que l'utilisateur voit plus petits que la limite
 * qu'on lui a annoncée.
 */
export function attachmentBytes(attachment: MessageAttachmentInput): number {
  let bytes = 0;
  for (const part of attachment.content) {
    if (part.type === "text") bytes += utf8Length(part.text);
    else bytes += base64PayloadBytes(part.image);
  }
  return bytes;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Taille décodée d'un `data:<type>;base64,<charge>`, sans décoder.
 *
 * Une chaîne base64 de n caractères porte 3n/4 octets, moins le rembourrage
 * `=`. Ce qui n'est pas base64 (une URL `http:` qu'un adaptateur externe
 * poserait) retombe sur la longueur brute : mieux vaut surestimer que laisser
 * passer une pièce non bornée.
 */
function base64PayloadBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !/^data:[^,]*;base64$/i.test(dataUrl.slice(0, comma))) {
    return utf8Length(dataUrl);
  }
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * Les deux seuls constructeurs de pièce jointe du dépôt.
 *
 * Ils reproduisent EXACTEMENT ce que les adaptateurs d'assistant-ui rendent
 * (`@assistant-ui/core/dist/adapters/attachment.js`,
 * `SimpleImageAttachmentAdapter.send` / `SimpleTextAttachmentAdapter.send`) :
 * un data-URI pour une image, un `<attachment name=…>` pour un texte. Les
 * deux clients passent par ici : le web depuis un `File` du navigateur, le
 * client natif depuis une URI du sélecteur : pour que la forme envoyée au cloud API ne
 * dépende jamais de la plateforme qui l'a produite.
 */
export function imageAttachment(
  name: string,
  contentType: string,
  dataUrl: string,
): MessageAttachmentInput {
  return { name, contentType, kind: "image", content: [{ type: "image", image: dataUrl }] };
}

export function documentAttachment(
  name: string,
  contentType: string,
  text: string,
): MessageAttachmentInput {
  return {
    name,
    // Un `.ts` arrive sans type MIME : on nomme ce qu'on en a fait plutôt que
    // de laisser une chaîne vide traverser jusqu'au prompt.
    contentType: contentType || "text/plain",
    kind: "document",
    content: [{ type: "text", text: `<attachment name=${name}>\n${text}\n</attachment>` }],
  };
}

export type AttachmentRejection =
  | { code: "ATTACHMENTS_TOO_MANY"; max: number }
  | { code: "ATTACHMENT_TOO_LARGE"; name: string; bytes: number; max: number }
  | { code: "ATTACHMENTS_TOO_LARGE"; bytes: number; max: number }
  | { code: "ATTACHMENT_EMPTY"; name: string };

/**
 * La garde du serveur. Rend la PREMIÈRE raison de refus, ou `null`.
 *
 * Nommer le refus plutôt que tronquer en silence : une pièce jointe qu'on
 * rogne sans le dire fait répondre le bot à côté, et l'utilisateur n'a aucun
 * moyen de savoir pourquoi.
 */
export function rejectAttachments(
  attachments: readonly MessageAttachmentInput[],
): AttachmentRejection | null {
  if (attachments.length > ATTACHMENT_LIMITS.maxCount) {
    return { code: "ATTACHMENTS_TOO_MANY", max: ATTACHMENT_LIMITS.maxCount };
  }
  let total = 0;
  for (const attachment of attachments) {
    const bytes = attachmentBytes(attachment);
    if (bytes === 0) return { code: "ATTACHMENT_EMPTY", name: attachment.name };
    if (bytes > ATTACHMENT_LIMITS.maxBytesEach) {
      return {
        code: "ATTACHMENT_TOO_LARGE",
        name: attachment.name,
        bytes,
        max: ATTACHMENT_LIMITS.maxBytesEach,
      };
    }
    total += bytes;
  }
  if (total > ATTACHMENT_LIMITS.maxBytesTotal) {
    return { code: "ATTACHMENTS_TOO_LARGE", bytes: total, max: ATTACHMENT_LIMITS.maxBytesTotal };
  }
  return null;
}

/**
 * Le prompt réellement envoyé au runtime : le texte tapé, puis une pièce par
 * bloc.
 *
 * Les parts `text` sont reprises telles quelles : `SimpleTextAttachmentAdapter`
 * les a déjà emballées dans `<attachment name=…>`, les emballer une seconde
 * fois donnerait au modèle deux niveaux de balises pour un seul fichier. Les
 * parts `image` n'ont pas d'emballage : on pose le nôtre, avec le nom et le
 * type, sinon le data-URI arriverait nu au milieu du prompt sans que rien ne
 * dise ce qu'il est.
 *
 * Un envoi sans texte est légitime (joindre une capture et rien d'autre) :
 * c'est la raison pour laquelle on ne préfixe pas d'une ligne vide.
 */
export function composeRunInput(
  text: string,
  attachments: readonly MessageAttachmentInput[],
): string {
  const blocks: string[] = [];
  const trimmed = text.trim();
  if (trimmed) blocks.push(trimmed);
  for (const attachment of attachments) {
    for (const part of attachment.content) {
      // L'image part en part `image_url` du run (le worker la relit du
      // magasin) : `input` n'en garde que le nom, jamais le data-URI.
      if (part.type === "text") blocks.push(part.text);
      else blocks.push(imageAttachmentNote(attachment.name, attachment.contentType));
    }
  }
  return blocks.join("\n\n");
}

/** Le nom vient de l'utilisateur : un guillemet nu y casserait l'attribut. */
function escapeQuotes(value: string): string {
  return value.replace(/"/g, "'");
}

/** Une pièce telle que le fil la garde : l'identité, pas les octets. */
export type AttachmentChip = {
  id: string;
  name: string;
  contentType: string;
  kind: AttachmentKind;
};

/** Les octets relus du magasin, prêts à être remis devant le modèle. */
export type LoadedAttachment = {
  name: string;
  contentType: string;
  kind: AttachmentKind;
  data: Uint8Array;
};

/**
 * Ce qu'un tour de salon fait d'une pièce qu'il n'a pas pu relire, ou qu'il
 * laisse derrière lui.
 *
 * Même distinction qu'the reference app (`attachment-parts.ts`) : le message auquel on
 * répond échoue en le disant (`missing`), un message plus ancien dit seulement
 * qu'il n'est pas dans CE tour (`skipped`). Les deux empêchent le modèle de
 * répondre comme s'il avait vu le fichier.
 */
export type AttachmentGap = "missing" | "skipped";

/** Les puces `attachment` d'un contenu de message, dans l'ordre. */
export function attachmentChips(content: unknown): AttachmentChip[] {
  if (!Array.isArray(content)) return [];
  const chips: AttachmentChip[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type !== "attachment" || typeof record.id !== "string" || typeof record.name !== "string") continue;
    chips.push({
      id: record.id,
      name: record.name,
      contentType: typeof record.contentType === "string" ? record.contentType : "application/octet-stream",
      kind: record.kind === "image" ? "image" : "document",
    });
  }
  return chips;
}

/**
 * Le bloc d'une pièce relue.
 *
 * Un document est du texte : il entre dans `input`, comme en message direct.
 * Une image n'y entre PAS en Base64 : coller le data-URI fait deux dégâts.
 * `vision_analyze` cherche un fichier, pas une chaîne, et échoue tout de
 * suite. Et une capture de 500 Ko devient ~200 000 jetons, assez pour
 * dépasser à elle seule le budget du workflow de salon (120 000), une fois
 * par membre. Elle voyage en part `image_url` du run (`hermesRunRequestBody`),
 * et le texte n'en garde que le nom.
 */
function inlineAttachmentBlock(file: LoadedAttachment): string {
  if (file.kind === "image") return imageAttachmentNote(file.name, file.contentType);
  const body = new TextDecoder().decode(file.data);
  return `<attachment name="${escapeQuotes(file.name)}" type="${escapeQuotes(file.contentType)}">\n${body}\n</attachment>`;
}

/**
 * Le nom d'une image jointe au tour ; ses pixels suivent en part `image_url`.
 * Le nom seul faisait croire à un fichier : le modèle appelait
 * `vision_analyze("IMG_8245.jpg")`, qui échoue (aucun fichier de ce nom dans
 * le bac à sable) et laissait un outil rouge au fil avant la vraie réponse.
 */
export function imageAttachmentNote(name: string, contentType: string): string {
  return `[image attached: "${escapeQuotes(name)}" (${escapeQuotes(contentType)}), sent with this message as an image you can already see. It is not a file in your workspace: read it directly, do not open it with vision_analyze or a file tool]`;
}

/** L'image n'a pas pu partir avec le tour : le modèle ne doit pas faire comme s'il l'avait vue. */
export function imageNotSentNote(name: string, reason: "missing" | "too_large"): string {
  const why = reason === "missing"
    ? "it is no longer available"
    : "this turn would exceed the connector's request size limit";
  return `[image "${escapeQuotes(name)}" was not sent to you: ${why}. Do not describe it.]`;
}

/**
 * Le texte qu'un modèle doit lire d'un message stocké : les parts `text`,
 * puis chaque pièce. Une puce sans octets n'est pas omise : le modèle doit
 * savoir qu'un fichier était là et qu'il ne l'a pas.
 */
export function modelTextFromContent(
  content: unknown,
  files: ReadonlyMap<string, LoadedAttachment | AttachmentGap>,
): string {
  const text = Array.isArray(content)
    ? content
      .filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join("\n")
      .trim()
    : "";
  const blocks: string[] = [];
  if (text) blocks.push(text);
  for (const chip of attachmentChips(content)) {
    const file = files.get(chip.id);
    if (chip.kind === "image") {
      // Chargée = elle part en `image_url` avec ce tour ; sinon elle est
      // nommée comme absente, au même titre qu'un document.
      if (file && typeof file === "object") {
        blocks.push(imageAttachmentNote(chip.name, chip.contentType));
        continue;
      }
      if (file === "missing") {
        blocks.push(imageNotSentNote(chip.name, "missing"));
        continue;
      }
      blocks.push(`[image "${escapeQuotes(chip.name)}" from an earlier message is not included in this turn]`);
      continue;
    }
    if (file && typeof file === "object") {
      blocks.push(inlineAttachmentBlock(file));
      continue;
    }
    const name = chip.name.replace(/"/g, "'");
    blocks.push(file === "skipped"
      ? `[attachment "${name}" from an earlier message was not included in this turn]`
      : `[attachment "${name}" is no longer available]`);
  }
  return blocks.join("\n\n");
}

/**
 * Ce que le fil montre : le texte tapé, puis une puce par pièce.
 *
 * La charge n'y est pas, c'est délibéré (voir l'en-tête). Une part `text`
 * vide n'est pas émise : une bulle vide au-dessus des puces se lirait comme un
 * message perdu.
 */
export function displayContent(
  text: string,
  attachments: readonly StoredAttachment[],
): MessageContent {
  const content: MessageContent = [];
  const trimmed = text.trim();
  if (trimmed) content.push({ type: "text", text: trimmed });
  for (const attachment of attachments) {
    content.push({
      type: "attachment",
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      kind: attachment.kind,
      bytes: attachmentBytes(attachment),
    });
  }
  return content;
}

/** Une pièce jointe une fois rangée : la même, plus l'identifiant de sa ligne. */
export type StoredAttachment = MessageAttachmentInput & { id: string };

/**
 * Les OCTETS de la pièce, tels que la base les garde et que la route les sert.
 *
 * Une image revient de son data-URI ; un document est dé-emballé de son
 * `<attachment name=…>`, parce que ce qu'on range doit être LE FICHIER : le
 * ré-ouvrir plus tard ne doit pas rendre nos balises à l'utilisateur. Le
 * dé-emballage ne devine rien : il défait exactement ce que
 * `documentAttachment` a posé, et retombe sur le texte entier si la forme ne
 * correspond pas.
 */
export function attachmentPayload(attachment: MessageAttachmentInput): {
  data: Uint8Array;
  contentType: string;
} {
  const part = attachment.content[0];
  if (part && part.type === "image") {
    return { data: base64ToBytes(part.image), contentType: attachment.contentType };
  }
  const text = attachment.content
    .map((item) => (item.type === "text" ? unwrapDocument(item.text) : ""))
    .join("\n");
  return { data: new TextEncoder().encode(text), contentType: attachment.contentType };
}

/** Défait l'emballage de `documentAttachment`, et rien d'autre. */
function unwrapDocument(text: string): string {
  const match = /^<attachment name=[^>\n]*>\n([\s\S]*)\n<\/attachment>$/.exec(text);
  return match ? match[1]! : text;
}

function base64ToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
