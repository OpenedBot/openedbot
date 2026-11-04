import type { CSSProperties } from "react";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { resolveBotArtwork } from "@openedbot/browser-face/artworks";
import { resolveFace } from "@openedbot/browser-face/presets";

/**
 * La couleur de la bulle de l'utilisateur dans le fil d'un bot, ou `null`
 * (la bulle reste blanche, comme avant).
 *
 * Seul un visage coloré (la pastille bloub choisie dans l'éditeur) donne sa
 * couleur, en aplat, comme grokbot. Un avatar robot, qu'il vienne du
 * catalogue, de l'identifiant (bot qui n'a rien choisi) ou d'un fichier
 * téléversé, n'a pas UNE couleur : la bulle reste neutre. La résolution est
 * celle de `BotFace`, pour que la bulle suive ce que montre l'avatar.
 */
export function botBubbleColor(botId: string | null | undefined, face: BotFaceSpec | null | undefined): string | null {
  if (!botId || !face) return null;
  if (face.artwork?.startsWith("/api/") || resolveBotArtwork(face.artwork)) return null;
  return resolveFace(face, botId).color.hex;
}

/** La bulle de l'utilisateur teintée par le bot, une valeur par thème. */
export type BotBubbleFill = { light: string; dark: string };

/*
 * Grok Bot (app desktop, `dist/renderer/assets/index.eager-common-*.js`) :
 * en DM, la bulle de l'utilisateur prend la teinte du bot, l'aplat
 * `{teinte}FillHover` en clair (primitive 2) et `{teinte}Fill` en sombre
 * (primitive 1), texte blanc. L'encre et le gris (`black`, `gray` chez lui) ne
 * teintent pas, la crème non plus (absente de sa palette) : la bulle reste
 * neutre. Notre palette → la sienne : ambre = yellow, turquoise = cyan,
 * violet = purple, rose = magenta.
 */
const GROK_BOT_USER_BUBBLE: Readonly<Record<string, BotBubbleFill>> = {
  rouge: { light: "#c82532", dark: "#cf2b35" },
  orange: { light: "#d2550a", dark: "#cd5309" },
  ambre: { light: "#c2730b", dark: "#c8770c" },
  vert: { light: "#0d9655", dark: "#0e9f5a" },
  turquoise: { light: "#0d9381", dark: "#0e9886" },
  bleu: { light: "#126fd4", dark: "#116dd2" },
  violet: { light: "#7442d1", dark: "#7845d7" },
  rose: { light: "#c82779", dark: "#cf297e" },
  brun: { light: "#86592e", dark: "#8c5d31" },
};

/**
 * L'aplat Grok Bot de la bulle de l'utilisateur dans le fil d'un bot, ou
 * `null` (bulle neutre) : même règle d'avatar que `botBubbleColor`, plus les
 * couleurs que Grok Bot ne teinte pas.
 */
export function botUserBubbleFill(botId: string | null | undefined, face: BotFaceSpec | null | undefined): BotBubbleFill | null {
  if (!botId || !face) return null;
  if (face.artwork?.startsWith("/api/") || resolveBotArtwork(face.artwork)) return null;
  return GROK_BOT_USER_BUBBLE[resolveFace(face, botId).color.id] ?? null;
}

/** Le texte posé sur un aplat clair (ambre, vert, crème…). */
export const DARK_TINT_TEXT = "#0a0a0a";

function channels(hex: string): [number, number, number] | null {
  const digits = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!digits) return null;
  const value = Number.parseInt(digits, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Luminance relative WCAG 2.x. */
function luminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * Le texte d'un aplat de la couleur du bot : blanc tant qu'il garde 3:1
 * (rouge, bleu, violet, rose, brun, encre : le blanc de grokbot), sinon
 * l'encre. Le blanc sur l'ambre ou le vert tombait sous 2,1:1, illisible.
 * 3:1 plutôt que 4,5:1 : à 4,5, le rouge et le violet passaient en texte
 * noir, la bulle ne ressemblait plus à la couleur choisie.
 */
export function tintTextColor(hex: string): string {
  const rgb = channels(hex);
  if (!rgb) return "#ffffff";
  return 1.05 / (luminance(rgb) + 0.05) >= 3 ? "#ffffff" : DARK_TINT_TEXT;
}

/** En dessous, une couleur est un gris (encre, crème, gris) : pas un accent. */
const MIN_ACCENT_CHROMA = 32;

/**
 * La couleur d'accent d'une conversation : celle du bot, ou `null` pour
 * garder l'accent de l'app. Un gris ne remplace pas l'accent : un bouton
 * principal encre disparaîtrait sur le fond sombre, crème sur le fond clair.
 */
export function botAccentColor(bubbleColor: string | null): string | null {
  if (!bubbleColor) return null;
  const rgb = channels(bubbleColor);
  if (!rgb) return null;
  return Math.max(...rgb) - Math.min(...rgb) >= MIN_ACCENT_CHROMA ? bubbleColor : null;
}

/**
 * Le style que l'écran d'un bot pose sur sa colonne : la couleur du bot
 * (`--bot-tint`, son texte) et l'aplat Grok Bot de la bulle de l'utilisateur
 * par thème (`--ohb-user-fill-*`, lus par thread-theme.css ; absents, la bulle
 * reste neutre).
 */
export function botTintStyle(bubbleColor: string | null, userFill: BotBubbleFill | null): CSSProperties | undefined {
  if (!bubbleColor) return undefined;
  return {
    "--bot-tint": bubbleColor,
    "--bot-tint-text": tintTextColor(bubbleColor),
    ...(userFill ? { "--ohb-user-fill-light": userFill.light, "--ohb-user-fill-dark": userFill.dark } : {}),
  } as CSSProperties;
}
