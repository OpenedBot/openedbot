import { useId } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { BRAND_MARKS, type BrandMarkKey } from "./brand-marks";

/** Inline SVG marks: no remote image: the PWA also runs on LAN http and offline. */

type KnownProvider = {
  label: string;
  mark: BrandMarkKey;
  /** Two providers that share a mark are told apart by this label. */
  tag?: string;
};

const PILL = "flex size-6 shrink-0 items-center justify-center rounded-md";
const NEUTRAL = "bg-foreground/10 text-foreground";
const ORANGE = "bg-orange-500/15 text-orange-700 dark:text-orange-300";
const BLUE = "bg-blue-500/15 text-blue-700 dark:text-blue-300";
const GREEN = "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";

const MARK_TINTS: Record<BrandMarkKey, string> = {
  anthropic: ORANGE,
  openai: NEUTRAL,
  opencode: NEUTRAL,
  openrouter: NEUTRAL,
  grok: NEUTRAL,
  x: NEUTRAL,
  googlegemini: BLUE,
  googlecloud: BLUE,
  deepseek: BLUE,
  ollama: NEUTRAL,
  huggingface: NEUTRAL,
  nvidia: GREEN,
  githubcopilot: NEUTRAL,
  amazonaws: ORANGE,
  microsoftazure: BLUE,
  meta: NEUTRAL,
  qwen: ORANGE,
  alibabacloud: ORANGE,
  kimi: NEUTRAL,
  minimax: NEUTRAL,
  xiaomi: ORANGE,
  mistralai: ORANGE,
  vercel: NEUTRAL,
};

/**
 * Each mark in its brand colour, for the bare glyphs of the model picker
 * (`colored`). A light and a dark value: a brand hue that reads on white can
 * vanish on #262626, and the reverse. Monochrome brands (OpenAI, xAI, Ollama…)
 * take the full text colour, black in light, white in dark.
 */
const MONO = "text-foreground";
const BRAND_INK: Record<BrandMarkKey, string> = {
  anthropic: "text-[#D97757]",
  openai: MONO,
  opencode: MONO,
  openrouter: "text-[#6467F2] dark:text-[#8B8DF7]",
  grok: MONO,
  x: MONO,
  googlegemini: "text-[#3186FF] dark:text-[#5BA0FF]",
  googlecloud: "text-[#4285F4] dark:text-[#6EA1F7]",
  deepseek: "text-[#4D6BFE] dark:text-[#7088FF]",
  ollama: MONO,
  huggingface: "text-[#E8A500] dark:text-[#FFD21E]",
  nvidia: "text-[#76B900]",
  githubcopilot: MONO,
  amazonaws: "text-[#FF9900]",
  microsoftazure: "text-[#0078D4] dark:text-[#3B9BEA]",
  meta: "text-[#0467DF] dark:text-[#4C8DFF]",
  qwen: "text-[#615CED] dark:text-[#8A86F5]",
  alibabacloud: "text-[#FF6A00]",
  kimi: MONO,
  minimax: "text-[#E73562] dark:text-[#F25C80]",
  xiaomi: "text-[#FF6900]",
  mistralai: "text-[#FA520F]",
  vercel: MONO,
};

/** Gemini's sparkle is a gradient, not a flat hue (blue, violet, rose). */
const GEMINI_STOPS = ["#4285F4", "#9B72CB", "#D96570"] as const;

const PROVIDERS: Record<string, KnownProvider> = {
  anthropic: { label: "Anthropic", mark: "anthropic" },
  "openai-codex": { label: "OpenAI Codex", mark: "openai", tag: "Codex" },
  "openai-api": { label: "OpenAI API", mark: "openai", tag: "API" },
  "opencode-free": { label: "OpenCode Free", mark: "opencode" },
  "opencode-zen": { label: "OpenCode Zen", mark: "opencode" },
  openrouter: { label: "OpenRouter", mark: "openrouter" },
  xai: { label: "xAI", mark: "x" },
  // The SuperGrok / Premium+ subscription: the Grok mark, not X's.
  "xai-oauth": { label: "xAI", mark: "grok" },
  gemini: { label: "Google Gemini", mark: "googlegemini" },
  vertex: { label: "Google Vertex AI", mark: "googlecloud" },
  deepseek: { label: "DeepSeek", mark: "deepseek" },
  "ollama-cloud": { label: "Ollama Cloud", mark: "ollama" },
  huggingface: { label: "Hugging Face", mark: "huggingface" },
  nvidia: { label: "NVIDIA", mark: "nvidia" },
  copilot: { label: "GitHub Copilot", mark: "githubcopilot" },
  "copilot-acp": { label: "GitHub Copilot (ACP)", mark: "githubcopilot" },
  bedrock: { label: "Amazon Bedrock", mark: "amazonaws" },
  "azure-foundry": { label: "Azure AI Foundry", mark: "microsoftazure" },
  "meta-ai": { label: "Meta AI", mark: "meta" },
  "qwen-oauth": { label: "Qwen", mark: "qwen" },
  alibaba: { label: "Alibaba Cloud", mark: "alibabacloud" },
  "alibaba-coding-plan": { label: "Alibaba Coding Plan", mark: "alibabacloud" },
  "kimi-coding": { label: "Kimi", mark: "kimi" },
  minimax: { label: "MiniMax", mark: "minimax" },
  "minimax-oauth": { label: "MiniMax", mark: "minimax" },
  xiaomi: { label: "Xiaomi", mark: "xiaomi" },
  mistral: { label: "Mistral AI", mark: "mistralai" },
  "ai-gateway": { label: "Vercel AI Gateway", mark: "vercel" },
};

function fallbackMark(label: string): string {
  const parts = label.split(/[\s-]+/).filter((part) => part.length > 0);
  const first = parts[0];
  const second = parts[1];
  if (first !== undefined && second !== undefined) {
    return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
  }
  return (first ?? label).slice(0, 2).toUpperCase() || "?";
}

/** A provider's readable name: the local table first, then the runtime's label, then the slug. */
export function providerLabel(provider: string, name?: string): string {
  return PROVIDERS[provider]?.label ?? ((name ?? "").trim() || provider);
}

/**
 * `name` is the label the Hermes runtime gives the provider: on a slug
 * with no known mark, it is better to read it than to spell the technical slug.
 *
 * `decorative`: the chip lives in a control that already carries its own name
 * (the « Limites » card). It then stays silent instead of adding one more mark
 * to the button's accessible name.
 */
export function ProviderIcon({ provider, name, decorative = false, tagged = false, withTitle = true, colored = false, className }: {
  provider: string;
  name?: string;
  decorative?: boolean;
  /** Shows the label (`Codex`, `API`) under the mark: the picker's rail has only the icon to name the tab. */
  tagged?: boolean;
  /** `false` when the control already carries its own tooltip: no native `title` doubled. */
  withTitle?: boolean;
  /** The bare glyph in its brand colour (`BRAND_INK`), instead of the tinted pill's ink. */
  colored?: boolean;
  className?: string;
}) {
  const gradientId = useId();
  const visual = PROVIDERS[provider];
  if (visual !== undefined) {
    const mark = BRAND_MARKS[visual.mark];
    const gradient = colored && visual.mark === "googlegemini";
    return (
      <span
        aria-hidden={decorative ? true : undefined}
        aria-label={decorative ? undefined : visual.label}
        title={withTitle ? visual.label : undefined}
        className={cn(PILL, "relative", MARK_TINTS[visual.mark], colored && BRAND_INK[visual.mark], className)}
      >
        <svg viewBox="0 0 24 24" fill={gradient ? `url(#${gradientId})` : "currentColor"} fillRule={visual.mark === "grok" ? "evenodd" : undefined} aria-hidden className="size-4">
          {gradient ? (
            <defs>
              <linearGradient id={gradientId} x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse">
                {GEMINI_STOPS.map((stop, index) => (
                  <stop key={stop} offset={index / (GEMINI_STOPS.length - 1)} stopColor={stop} />
                ))}
              </linearGradient>
            </defs>
          ) : null}
          <path d={mark.path} />
        </svg>
        {tagged && visual.tag ? (
          <span
            aria-hidden
            className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded-[3px] bg-foreground px-[3px] text-[7px] font-semibold leading-[10px] whitespace-nowrap text-background"
          >
            {visual.tag}
          </span>
        ) : null}
      </span>
    );
  }
  const label = (name ?? "").trim() || provider || "?";
  return (
    <span
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label}
      title={withTitle ? label : undefined}
      className={cn(PILL, "bg-muted text-[10px] font-semibold uppercase text-muted-foreground", className)}
    >
      {fallbackMark(label)}
    </span>
  );
}
