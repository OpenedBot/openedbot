import type { VoiceEnvironmentObservation } from "@openedbot/browser-face/voice-ui-state";

/**
 * Sous-ensemble volontairement petit de Web Speech. L'API principale reste
 * préfixée dans plusieurs navigateurs et TypeScript ne publie pas encore le
 * constructeur, même s'il publie les types des résultats.
 */
export type WebSpeechResult = {
  readonly isFinal: boolean;
  readonly 0?: { readonly transcript: string };
};

export type WebSpeechResultList = {
  readonly length: number;
  readonly [index: number]: WebSpeechResult;
};

export type WebSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: { readonly results: WebSpeechResultList }) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export type WebSpeechRecognitionConstructor = new () => WebSpeechRecognition;

export type VoiceRecognitionFailure =
  | "permission-denied"
  | "microphone-unavailable"
  | "aborted"
  | "no-speech"
  | "network"
  | "transcription-failed";

export type VoiceRecognitionUpdate = {
  /** Segments confirmés par le moteur de reconnaissance. */
  finalTranscript: string;
  /** Segment provisoire : visible, mais jamais envoyé seul sans arrêt/relecture. */
  interimTranscript: string;
};

export type VoiceRecognitionCallbacks = {
  onStart: () => void;
  onResult: (update: VoiceRecognitionUpdate) => void;
  onEnd: () => void;
  onError: (failure: VoiceRecognitionFailure) => void;
};

export type VoiceRecognitionOptions = {
  /**
   * `false` laisse l'endpoint de silence du navigateur terminer un tour de
   * conversation. La dictée longue garde le défaut `true`.
   */
  continuous?: boolean;
};

export interface VoiceRecognitionAdapter {
  initialObservation(): VoiceEnvironmentObservation;
  refreshObservation(): Promise<VoiceEnvironmentObservation>;
  start(locale: "fr" | "en", callbacks: VoiceRecognitionCallbacks, options?: VoiceRecognitionOptions): void;
  stop(): void;
  cancel(): void;
  dispose(): void;
}

type PermissionStatusLike = { readonly state: "granted" | "denied" | "prompt" };

export type VoiceBrowserHost = {
  readonly SpeechRecognition?: WebSpeechRecognitionConstructor;
  readonly webkitSpeechRecognition?: WebSpeechRecognitionConstructor;
  /** Absent des faux hôtes de test ; seuls `false` et l'absence sont distincts. */
  readonly isSecureContext?: boolean;
};

export type VoiceNavigator = {
  readonly permissions?: {
    query(descriptor: { name: string }): Promise<PermissionStatusLike>;
  };
};

function normalize(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ajoute une dictée à un brouillon sans coller les mots ni écraser le texte. */
export function mergeVoiceTranscript(draft: string, transcript: string): string {
  return normalize([draft, transcript]);
}

function recognitionFailure(error: string): VoiceRecognitionFailure {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission-denied";
    case "audio-capture":
      return "microphone-unavailable";
    case "aborted":
      return "aborted";
    case "no-speech":
      return "no-speech";
    case "network":
      return "network";
    default:
      return "transcription-failed";
  }
}

/**
 * Adaptateur réel vers SpeechRecognition / webkitSpeechRecognition.
 *
 * Il n'ouvre jamais `getUserMedia` pour « tester » le micro : cela créerait un
 * second flux, une seconde demande d'autorisation et un voyant d'écoute que la
 * dictée ne contrôle pas. Le moteur déclenche lui-même l'autorisation au geste
 * utilisateur ; Permissions API permet seulement de refuser en amont un état
 * déjà `denied`.
 */
export class BrowserVoiceRecognitionAdapter implements VoiceRecognitionAdapter {
  private readonly Constructor: WebSpeechRecognitionConstructor | null;
  private recognition: WebSpeechRecognition | null = null;

  constructor(
    private readonly host: VoiceBrowserHost,
    private readonly navigatorLike: VoiceNavigator,
  ) {
    this.Constructor = host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
  }

  initialObservation(): VoiceEnvironmentObservation {
    if (!this.Constructor || this.host.isSecureContext === false) {
      return {
        backend: { supported: false, reason: "VOICE_CAPABILITY_UNSUPPORTED" },
        microphone: null,
      };
    }
    // `prompt` n'est pas un refus. La demande réelle reste réservée au clic.
    return { backend: { supported: true }, microphone: { available: true } };
  }

  async refreshObservation(): Promise<VoiceEnvironmentObservation> {
    const initial = this.initialObservation();
    if (!initial.backend?.supported) return initial;

    try {
      const permission = await this.navigatorLike.permissions?.query({ name: "microphone" });
      if (permission?.state === "denied") {
        return {
          backend: { supported: true },
          microphone: { available: false, reason: "VOICE_MICROPHONE_PERMISSION_DENIED" },
        };
      }
    } catch {
      // Safari/WebKit peut exposer SpeechRecognition sans accepter `microphone`
      // dans Permissions API. La vraie demande du moteur reste la source.
    }
    return initial;
  }

  start(locale: "fr" | "en", callbacks: VoiceRecognitionCallbacks, options: VoiceRecognitionOptions = {}): void {
    if (!this.Constructor || this.host.isSecureContext === false) {
      throw new Error("Web Speech recognition is unavailable");
    }

    this.dispose();
    const recognition = new this.Constructor();
    this.recognition = recognition;
    recognition.continuous = options.continuous ?? true;
    recognition.interimResults = true;
    recognition.lang = locale === "fr" ? "fr-FR" : "en-US";
    recognition.maxAlternatives = 1;
    recognition.onstart = callbacks.onStart;
    recognition.onresult = (event) => {
      const finalParts: string[] = [];
      const interimParts: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const text = result?.[0]?.transcript ?? "";
        if (!text.trim()) continue;
        (result.isFinal ? finalParts : interimParts).push(text);
      }
      callbacks.onResult({
        finalTranscript: normalize(finalParts),
        interimTranscript: normalize(interimParts),
      });
    };
    recognition.onerror = (event) => callbacks.onError(recognitionFailure(event.error));
    recognition.onend = () => {
      if (this.recognition === recognition) this.recognition = null;
      callbacks.onEnd();
    };

    try {
      recognition.start();
    } catch (error) {
      this.detach(recognition);
      this.recognition = null;
      throw error;
    }
  }

  stop(): void {
    this.recognition?.stop();
  }

  cancel(): void {
    this.recognition?.abort();
  }

  dispose(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    this.recognition = null;
    this.detach(recognition);
    try {
      recognition.abort();
    } catch {
      // Un moteur déjà terminé peut jeter ; il n'écoute plus et peut être oublié.
    }
  }

  private detach(recognition: WebSpeechRecognition): void {
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  }
}

export function createBrowserVoiceRecognitionAdapter(): VoiceRecognitionAdapter {
  return new BrowserVoiceRecognitionAdapter(
    window as unknown as VoiceBrowserHost,
    navigator as unknown as VoiceNavigator,
  );
}
