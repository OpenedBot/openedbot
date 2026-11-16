import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { speechRateFor } from "./speech-rates";
import { markdownToSpeechText } from "./speech-text";
import {
  createBrowserSpeechSynthesisAdapter,
  readSpeechOutputSettings,
  SPEECH_SETTINGS_EVENT,
  type SpeechOutputSettings,
  type SpeechSynthesisAdapter,
} from "./web-speech-synthesis";

export type ThreadSpeechState = {
  id: string | null;
  status: "idle" | "speaking" | "error";
};

/**
 * Read-aloud playback of the thread: one utterance at a time, toggled per
 * message. A generation counter drops callbacks of a cancelled utterance;
 * a scope change (thread switch) or `speechDisabled` cancels the current one.
 */
export function useThreadSpeech({
  injectedAdapter,
  speechScope,
  speechDisabled,
  locale,
}: {
  injectedAdapter?: SpeechSynthesisAdapter;
  speechScope: string;
  speechDisabled: boolean;
  locale: "fr" | "en";
}) {
  const speechAdapter = useMemo(
    () => injectedAdapter ?? createBrowserSpeechSynthesisAdapter(),
    [injectedAdapter],
  );
  const [speechSettings, setSpeechSettings] = useState<SpeechOutputSettings>(
    () => readSpeechOutputSettings(),
  );
  const [speechState, setSpeechState] = useState<ThreadSpeechState>({ id: null, status: "idle" });
  const speechGeneration = useRef(0);

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<SpeechOutputSettings>).detail;
      setSpeechSettings(detail ?? readSpeechOutputSettings());
    };
    window.addEventListener(SPEECH_SETTINGS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SPEECH_SETTINGS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    speechGeneration.current += 1;
    speechAdapter.cancel();
    setSpeechState({ id: null, status: "idle" });
    return () => {
      speechGeneration.current += 1;
      speechAdapter.cancel();
    };
  }, [speechAdapter, speechScope]);

  useEffect(() => {
    if (!speechDisabled) return;
    speechGeneration.current += 1;
    speechAdapter.cancel();
    setSpeechState({ id: null, status: "idle" });
  }, [speechAdapter, speechDisabled]);

  const playSpeech = useCallback((id: string, markdown: string, botVoiceId?: string | null, botId?: string | null) => {
    if (!speechAdapter.supported) return;
    if (speechState.id === id && speechState.status === "speaking") {
      speechGeneration.current += 1;
      speechAdapter.cancel();
      setSpeechState({ id: null, status: "idle" });
      return;
    }
    const text = markdownToSpeechText(markdown, locale);
    if (!text) return;
    const generation = ++speechGeneration.current;
    setSpeechState({ id, status: "speaking" });
    speechAdapter.speak({
      text,
      lang: locale,
      voiceURI: botVoiceId ?? speechSettings.voiceURI,
      rate: speechRateFor(botId),
      onStart: () => {
        if (speechGeneration.current === generation) setSpeechState({ id, status: "speaking" });
      },
      onEnd: () => {
        if (speechGeneration.current === generation) setSpeechState({ id: null, status: "idle" });
      },
      onError: () => {
        if (speechGeneration.current === generation) setSpeechState({ id, status: "error" });
      },
    });
  }, [locale, speechAdapter, speechSettings.voiceURI, speechState]);

  return { speechAdapter, speechSettings, speechState, playSpeech };
}
