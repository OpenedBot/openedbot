export type SpeechVoice = {
  voiceURI: string;
  name: string;
  lang: string;
  default: boolean;
  localService: boolean;
};

export type SpeechRequest = {
  text: string;
  lang: string;
  voiceURI?: string | null;
  /** Reading speed (1 = normal), set per bot in the agent editor. */
  rate?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
};

export interface SpeechSynthesisAdapter {
  readonly supported: boolean;
  voices(): SpeechVoice[];
  subscribeVoicesChanged(callback: () => void): () => void;
  speak(request: SpeechRequest): void;
  cancel(): void;
}

export type SpeechOutputSettings = {
  autoRead: boolean;
  voiceURI: string | null;
};

export const SPEECH_SETTINGS_EVENT = "openedbot:speech-output-settings";
const SPEECH_SETTINGS_KEY = "openedbot:speech-output-settings:v1";
const MAX_UTTERANCE_LENGTH = 700;

export function readSpeechOutputSettings(): SpeechOutputSettings {
  if (typeof localStorage === "undefined") return { autoRead: false, voiceURI: null };
  try {
    const value = JSON.parse(localStorage.getItem(SPEECH_SETTINGS_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return { autoRead: false, voiceURI: null };
    const record = value as Record<string, unknown>;
    return {
      autoRead: record.autoRead === true,
      voiceURI: typeof record.voiceURI === "string" && record.voiceURI ? record.voiceURI : null,
    };
  } catch {
    return { autoRead: false, voiceURI: null };
  }
}

export function writeSpeechOutputSettings(settings: SpeechOutputSettings) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SPEECH_SETTINGS_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent(SPEECH_SETTINGS_EVENT, { detail: settings }));
  } catch {
    // A blocked/private storage must not prevent manual speech playback.
  }
}

export function splitSpeechText(text: string, maxLength = MAX_UTTERANCE_LENGTH): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength + 1);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    const whitespace = window.lastIndexOf(" ");
    const cut = sentence >= Math.floor(maxLength * 0.55) ? sentence + 1 : whitespace > 0 ? whitespace : maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function preferredSpeechVoice(
  voices: readonly SpeechVoice[],
  locale: string,
  preferredURI?: string | null,
): SpeechVoice | null {
  if (preferredURI) {
    const selected = voices.find((voice) => voice.voiceURI === preferredURI);
    if (selected) return selected;
  }
  const requested = locale.toLowerCase();
  const base = requested.split("-")[0] ?? requested;
  return voices.find((voice) => voice.default && voice.lang.toLowerCase().startsWith(base))
    ?? voices.find((voice) => voice.localService && voice.lang.toLowerCase().startsWith(base))
    ?? voices.find((voice) => voice.lang.toLowerCase().startsWith(base))
    ?? voices.find((voice) => voice.default)
    ?? voices[0]
    ?? null;
}

function voiceDto(voice: SpeechSynthesisVoice): SpeechVoice {
  return {
    voiceURI: voice.voiceURI,
    name: voice.name,
    lang: voice.lang,
    default: voice.default,
    localService: voice.localService,
  };
}

export function createBrowserSpeechSynthesisAdapter(): SpeechSynthesisAdapter {
  const host = typeof window === "undefined" ? null : window;
  const synthesis = host?.speechSynthesis ?? null;
  const Utterance = host?.SpeechSynthesisUtterance ?? null;
  let generation = 0;

  return {
    supported: Boolean(synthesis && Utterance),
    voices: () => synthesis?.getVoices().map(voiceDto) ?? [],
    subscribeVoicesChanged(callback) {
      if (!synthesis) return () => {};
      synthesis.addEventListener("voiceschanged", callback);
      return () => synthesis.removeEventListener("voiceschanged", callback);
    },
    speak(request) {
      if (!synthesis || !Utterance) {
        request.onError?.();
        return;
      }
      const chunks = splitSpeechText(request.text);
      if (!chunks.length) {
        request.onEnd?.();
        return;
      }
      generation += 1;
      const current = generation;
      synthesis.cancel();
      const selected = preferredSpeechVoice(this.voices(), request.lang, request.voiceURI);
      chunks.forEach((chunk, index) => {
        const utterance = new Utterance(chunk);
        utterance.lang = selected?.lang || request.lang;
        const nativeVoice = selected
          ? synthesis.getVoices().find((voice) => voice.voiceURI === selected.voiceURI)
          : null;
        if (nativeVoice) utterance.voice = nativeVoice;
        utterance.rate = request.rate ?? 1;
        if (index === 0) utterance.onstart = () => {
          if (generation === current) request.onStart?.();
        };
        if (index === chunks.length - 1) utterance.onend = () => {
          if (generation === current) request.onEnd?.();
        };
        utterance.onerror = () => {
          if (generation !== current) return;
          generation += 1;
          synthesis.cancel();
          request.onError?.();
        };
        synthesis.speak(utterance);
      });
    },
    cancel() {
      generation += 1;
      synthesis?.cancel();
    },
  };
}
