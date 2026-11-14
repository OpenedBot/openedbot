import type { CSSProperties } from "react";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { resolveBotArtwork } from "@openedbot/browser-face/artworks";
import { isMascotFace, resolveMascot } from "@openedbot/browser-face/mascot";
import { resolveFace } from "@openedbot/browser-face/presets";

/**
 * The user's bubble color in a bot's thread, or `null`
 * (the bubble stays white, as before).
 *
 * Only a colored face (the bloub chip chosen in the editor, or a cat) gives
 * its color, as a flat fill, like the reference app. A robot avatar, whether it comes from the
 * catalog, from the identifier (a bot that chose nothing) or from an uploaded
 * file, does not have ONE color: the bubble stays neutral. The resolution is
 * `BotFace`'s, so the bubble follows what the avatar shows.
 */
export function botBubbleColor(botId: string | null | undefined, face: BotFaceSpec | null | undefined): string | null {
  if (!botId || !face) return null;
  if (face.artwork?.startsWith("/api/") || resolveBotArtwork(face.artwork)) return null;
  if (isMascotFace(face)) return resolveMascot(face).color;
  return resolveFace(face, botId).color.hex;
}

/** The user's bubble tinted by the bot, one value per theme. */
export type BotBubbleFill = { light: string; dark: string };

/*
 * The reference app (desktop app, `dist/renderer/assets/index.eager-common-*.js`):
 * in a DM, the user's bubble takes the bot's tint, the flat fill
 * `{teinte}FillHover` in light (primitive 2) and `{teinte}Fill` in dark
 * (primitive 1), white text. Ink and gray (`black`, `gray` on their side) do not
 * tint, nor does cream (absent from their palette): the bubble stays
 * neutral. Our palette → theirs: ambre = yellow, turquoise = cyan,
 * violet = purple, rose = magenta.
 */
const STREAM_BOT_USER_BUBBLE: Readonly<Record<string, BotBubbleFill>> = {
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
 * The reference app flat fill of the user's bubble in a bot's thread, or
 * `null` (neutral bubble): the same avatar rule as `botBubbleColor`, plus the
 * colors the reference app does not tint.
 */
export function botUserBubbleFill(botId: string | null | undefined, face: BotFaceSpec | null | undefined): BotBubbleFill | null {
  if (!botId || !face) return null;
  if (face.artwork?.startsWith("/api/") || resolveBotArtwork(face.artwork)) return null;
  // A cat's colour outside the bloub palette (Méca's slate) has no reference fill: neutral bubble.
  if (isMascotFace(face)) return STREAM_BOT_USER_BUBBLE[resolveMascot(face).colorId ?? ""] ?? null;
  return STREAM_BOT_USER_BUBBLE[resolveFace(face, botId).color.id] ?? null;
}

/** The text laid on a light flat fill (ambre, vert, crème…). */
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
 * The text of a flat fill in the bot's color: white as long as it keeps 3:1
 * (rouge, bleu, violet, rose, brun, encre: the reference app's white), otherwise
 * ink. White on ambre or vert fell under 2.1:1, unreadable.
 * 3:1 rather than 4.5:1: at 4.5, rouge and violet switched to black
 * text, and the bubble no longer looked like the chosen color.
 */
export function tintTextColor(hex: string): string {
  const rgb = channels(hex);
  if (!rgb) return "#ffffff";
  return 1.05 / (luminance(rgb) + 0.05) >= 3 ? "#ffffff" : DARK_TINT_TEXT;
}

/** Below this, a color is a gray (encre, crème, gris): not an accent. */
const MIN_ACCENT_CHROMA = 32;

/**
 * A conversation's accent color: the bot's, or `null` to
 * keep the app accent. A gray does not replace the accent: an encre
 * primary button would disappear on the dark background, crème on the light background.
 */
export function botAccentColor(bubbleColor: string | null): string | null {
  if (!bubbleColor) return null;
  const rgb = channels(bubbleColor);
  if (!rgb) return null;
  return Math.max(...rgb) - Math.min(...rgb) >= MIN_ACCENT_CHROMA ? bubbleColor : null;
}

/**
 * The style a bot's screen sets on its column: the bot's color
 * (`--bot-tint`, its text) and the reference app flat fill of the user's bubble
 * per theme (`--openedbot-user-fill-*`, read by thread-theme.css; absent, the bubble
 * stays neutral).
 */
export function botTintStyle(bubbleColor: string | null, userFill: BotBubbleFill | null): CSSProperties | undefined {
  if (!bubbleColor) return undefined;
  return {
    "--bot-tint": bubbleColor,
    "--bot-tint-text": tintTextColor(bubbleColor),
    ...(userFill ? { "--openedbot-user-fill-light": userFill.light, "--openedbot-user-fill-dark": userFill.dark } : {}),
  } as CSSProperties;
}
