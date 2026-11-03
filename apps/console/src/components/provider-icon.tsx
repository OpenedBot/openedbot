import { cn } from "@openedbot/browser-ui-kit";
import { BRAND_MARKS, type BrandMarkKey } from "./brand-marks";

/** Marques SVG inline : aucune image distante : la PWA tourne aussi en LAN http et hors ligne. */

type KnownProvider = {
  label: string;
  mark: BrandMarkKey;
  /** Deux fournisseurs qui partagent une marque se distinguent par cette étiquette. */
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

const PROVIDERS: Record<string, KnownProvider> = {
  anthropic: { label: "Anthropic", mark: "anthropic" },
  "openai-codex": { label: "OpenAI Codex", mark: "openai", tag: "Codex" },
  "openai-api": { label: "OpenAI API", mark: "openai", tag: "API" },
  "opencode-free": { label: "OpenCode Free", mark: "opencode" },
  "opencode-zen": { label: "OpenCode Zen", mark: "opencode" },
  openrouter: { label: "OpenRouter", mark: "openrouter" },
  xai: { label: "xAI", mark: "x" },
  "xai-oauth": { label: "xAI", mark: "x" },
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

/** Le nom lisible d'un fournisseur : la table locale d'abord, puis le libellé du runtime, puis le slug. */
export function providerLabel(provider: string, name?: string): string {
  return PROVIDERS[provider]?.label ?? ((name ?? "").trim() || provider);
}

/**
 * `name` est le libellé que le runtime Hermes donne au fournisseur : sur un slug
 * sans marque connue, il vaut mieux le lire que d'épeler le slug technique.
 *
 * `decorative` : la pastille vit dans un contrôle qui porte déjà son propre nom
 * (la carte « Limites »). Elle se tait alors au lieu d'ajouter une marque de
 * plus au nom accessible du bouton.
 */
export function ProviderIcon({ provider, name, decorative = false, tagged = false, withTitle = true, className }: {
  provider: string;
  name?: string;
  decorative?: boolean;
  /** Affiche l'étiquette (`Codex`, `API`) sous la marque : le rail du sélecteur n'a que l'icône pour nommer l'onglet. */
  tagged?: boolean;
  /** `false` quand le contrôle porte déjà sa propre infobulle : pas de `title` natif en double. */
  withTitle?: boolean;
  className?: string;
}) {
  const visual = PROVIDERS[provider];
  if (visual !== undefined) {
    const mark = BRAND_MARKS[visual.mark];
    return (
      <span
        aria-hidden={decorative ? true : undefined}
        aria-label={decorative ? undefined : visual.label}
        title={withTitle ? visual.label : undefined}
        className={cn(PILL, "relative", MARK_TINTS[visual.mark], className)}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-4">
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
