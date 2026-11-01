import { useEffect, useMemo, useState } from "react";
import { IconPhoneOff, IconVolume } from "@tabler/icons-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import {
  createBrowserSpeechSynthesisAdapter,
  preferredSpeechVoice,
  readSpeechOutputSettings,
  writeSpeechOutputSettings,
  type SpeechOutputSettings as Settings,
  type SpeechSynthesisAdapter,
  type SpeechVoice,
} from "../lib/web-speech-synthesis";

/** Radix Select refuses an empty item value: sentinel for "browser default voice". */
const DEFAULT_VOICE = "__default__";

export function SpeechOutputSettings({
  adapter: injected,
  callAvailable = false,
  activeVoiceId = null,
}: {
  adapter?: SpeechSynthesisAdapter;
  callAvailable?: boolean;
  /** Voix persistée du bot actif, prioritaire sur le repli utilisateur. */
  activeVoiceId?: string | null;
}) {
  const { t, locale } = useT();
  const adapter = useMemo(() => injected ?? createBrowserSpeechSynthesisAdapter(), [injected]);
  const [settings, setSettings] = useState<Settings>(() => readSpeechOutputSettings());
  const [voices, setVoices] = useState<SpeechVoice[]>(() => adapter.voices());
  const selectedVoice = preferredSpeechVoice(voices, locale, activeVoiceId ?? settings.voiceURI);

  useEffect(() => {
    setVoices(adapter.voices());
    return adapter.subscribeVoicesChanged(() => setVoices(adapter.voices()));
  }, [adapter]);

  const update = (next: Settings) => {
    setSettings(next);
    writeSpeechOutputSettings(next);
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="speech-output-title">
      <header className="flex items-start gap-3">
        <span className="rounded-lg bg-muted p-2 text-muted-foreground">
          <IconVolume className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="speech-output-title" className="font-medium">{t("voicePanel.outputTitle")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {adapter.supported ? t("voicePanel.outputReady") : t("voicePanel.outputUnsupported")}
          </p>
        </div>
      </header>

      {adapter.supported ? (
        <div className="mt-4 space-y-3">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("voicePanel.voiceLabel")}</span>
            <Select
              value={voices.some((voice) => voice.voiceURI === settings.voiceURI) ? settings.voiceURI ?? DEFAULT_VOICE : DEFAULT_VOICE}
              onValueChange={(value) => update({ ...settings, voiceURI: value === DEFAULT_VOICE ? null : value })}
            >
              <SelectTrigger aria-label={t("voicePanel.voiceLabel")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VOICE}>{t("voicePanel.defaultVoice")}</SelectItem>
                {voices.map((voice) => (
                  <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} ({voice.lang} · {voice.localService
                      ? t("voicePanel.voiceLocal")
                      : t("voicePanel.voiceRemote")})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.autoRead}
              onChange={(event) => update({ ...settings, autoRead: event.target.checked })}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              <span className="block font-medium">{t("voicePanel.autoRead")}</span>
              <span className="block text-xs text-muted-foreground">{t("voicePanel.autoReadHint")}</span>
            </span>
          </label>
          <p role="note" className="text-xs leading-5 text-muted-foreground">
            {selectedVoice?.localService
              ? t("voicePanel.outputPrivacyLocal")
              : t("voicePanel.outputPrivacyRemote")}
          </p>
          {activeVoiceId ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {t("voicePanel.botVoiceOverride")}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex gap-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm text-muted-foreground">
        <IconPhoneOff className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          <strong className="text-foreground">
            {t(callAvailable ? "voicePanel.callHalfDuplex" : "voicePanel.callDmOnly")}
          </strong>{" "}
          {t(callAvailable ? "voicePanel.callHalfDuplexReason" : "voicePanel.callDmOnlyReason")}
        </p>
      </div>
    </section>
  );
}
