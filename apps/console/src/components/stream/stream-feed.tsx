import type { BotFaceSpec } from "@openedbot/contracts-api";
import { BotFace } from "../bot-face";

/*
 * The steps of a run as the « Réflexions » panel reads them
 * (`stream-thoughts-panel.tsx`): web searches and visited pages, tool calls,
 * and the sentences the bot wrote between them.
 */

export type StreamSite = { letter: string; color: string; name: string };

/** Who wrote a feed message: the bot of the turn, drawn with its own face. */
export type StreamSpeaker = { id: string; name: string; face?: BotFaceSpec | null };

/** A page a search found, for the panel's unfolded search row. */
export type StreamSource = { title: string; url: string; domain: string };

export type StreamFeedItem =
  | { id: string; kind: "search"; query: string; results: number; sites: StreamSite[]; sources?: StreamSource[]; pending?: boolean }
  | { id: string; kind: "visit"; url: string }
  /** `detail`: the call's error, or its output excerpt, unfolded in the panel. */
  | { id: string; kind: "tool"; label: string; pending?: boolean; failed?: boolean; detail?: string }
  /** grok's agent message: what the bot said between two steps, in its bubble. */
  | { id: string; kind: "msg"; agent: StreamSpeaker; text: string }
  | { id: string; kind: "status"; text: string; assistantText?: boolean };

/** The bot's face at a feed size (grok's `AgentOrb`). */
export function StreamSpeakerFace({ agent, size }: { agent: StreamSpeaker; size: number }) {
  return (
    <span aria-hidden="true" className="grid shrink-0 place-items-center overflow-hidden rounded-full" style={{ width: size, height: size }}>
      <BotFace name={agent.name} seed={agent.id} face={agent.face} className="size-full" />
    </span>
  );
}

/** A favicon stand-in: the site's initial on a colour drawn from its name (real favicons are third-party assets). */
export function streamSite(domain: string): StreamSite {
  const name = domain.replace(/^www\./, "");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { letter: (name.charAt(0) || "?").toUpperCase(), color: `hsl(${hash % 360} 62% 46%)`, name };
}

export function StreamFavicon({ site, size = 16 }: { site: StreamSite; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full leading-none font-semibold text-white"
      style={{ width: size, height: size, background: site.color, fontSize: size * 0.55 }}
    >
      {site.letter}
    </span>
  );
}
