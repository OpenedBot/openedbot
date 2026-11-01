import { ACCENTS, ACCENT_SWATCHES, THEME_MODES, useTheme, type AccentId } from "@openedbot/browser-ui-kit/theme";
import { LOCALES } from "@openedbot/contracts-locale";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useT, type Locale, type MessageKey } from "../../../lib/i18n";
import { ACTIONS, CardHeading, SectionHeading, SettingsCard } from "../../../components/settings/primitives";
import { AccountLayoutPicker } from "../../../components/settings/account-layout-picker";
import { InsetGroupedRow, InsetGroupedSection } from "../../../components/mobile/inset-grouped";
import { SettingsPane } from "../pane";
import { TEXT_SIZES, setTextSize, useTextSize } from "../../../lib/text-size";
import { setSettingsDisplay, useSettingsDisplay, type SettingsDisplay } from "../../../lib/settings-display";
import { useSettingsModal, useSettingsPage } from "../../../lib/settings-modal-context";
import { BOT_ACCENT_MODES, setBotAccentMode, useBotAccentMode, type BotAccentMode } from "../../../lib/bot-accent-preference";

const THEME_LABEL_KEY = {
  light: "settings.appearance.themeLight",
  dark: "settings.appearance.themeDark",
  system: "settings.appearance.themeSystem",
} as const;

const LOCALE_LABEL_KEY: Record<Locale, "settings.appearance.languageFr" | "settings.appearance.languageEn"> = {
  fr: "settings.appearance.languageFr",
  en: "settings.appearance.languageEn",
};

const BOT_ACCENT_LABEL_KEY: Record<BotAccentMode, MessageKey> = {
  bot: "settings.appearance.botAccentBot",
  app: "settings.appearance.botAccentApp",
};

const SETTINGS_DISPLAY_LABEL_KEY: Record<SettingsDisplay, MessageKey> = {
  modal: "settingsSidebar.displayModal",
  page: "settingsSidebar.displayPage",
};

const ACCENT_LABEL_KEY = Object.fromEntries(
  ACCENTS.map((accent) => [accent, `settings.appearance.accents.${accent}` as MessageKey]),
) as Record<AccentId, MessageKey>;

/**
 * Apparence et langue : la langue d'abord, puis le thème et la couleur d'accent.
 *
 * L'accent était volontairement masqué (décision du 16-08) ; réouvert le
 * 25-08 à la demande de l'opérateur. Le mécanisme est celui de
 * `@openedbot/browser-ui-kit/theme` : `setAccent` pose `data-accent` sur <html> immédiatement
 * et persiste dans `localStorage` (`ohb:theme`) : rien à câbler ici.
 */
export function AppearanceSettings() {
  const theme = useTheme();
  const { locale, setLocale, t } = useT();
  const isMobile = useIsMobile();
  const textSize = useTextSize();
  const botAccentMode = useBotAccentMode();
  const settingsDisplay = useSettingsDisplay();
  const settingsModal = useSettingsModal();
  const settingsPage = useSettingsPage();
  // Choisi depuis les réglages eux-mêmes, le mode s'applique tout de suite, par
  // la même bascule que l'en-tête : changer seulement la préférence ferait
  // disparaître la fenêtre ouverte sans rien ouvrir à sa place.
  const chooseSettingsDisplay = (display: SettingsDisplay) => {
    if (display === settingsDisplay) return;
    if (display === "page" && settingsModal?.openAsPage) settingsModal.openAsPage();
    else if (display === "modal" && settingsPage) settingsPage.openAsWindow();
    else setSettingsDisplay(display);
  };

  const accentSwatches = (
    <div className={isMobile ? "flex flex-wrap gap-3 px-4 py-3" : "mt-4 flex flex-wrap justify-end gap-2.5"}>
      {ACCENTS.map((accent) => {
        const selected = theme.accent === accent;
        return (
          <button
            key={accent}
            type="button"
            aria-pressed={selected}
            aria-label={t(ACCENT_LABEL_KEY[accent])}
            title={t(ACCENT_LABEL_KEY[accent])}
            onClick={() => theme.setAccent(accent)}
            data-accent-choice={accent}
            className={`size-11 rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:size-7 ${
              selected ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "ring-1 ring-border"
            }`}
            style={{ backgroundColor: ACCENT_SWATCHES[accent] }}
          />
        );
      })}
    </div>
  );

  if (isMobile) {
    return (
      <SettingsPane>
        <SectionHeading
          title={t("settings.appearance.title")}
          description={t("settings.appearance.description")}
        />
        <InsetGroupedSection caption={t("settings.appearance.languageTitle")}>
          {LOCALES.map((candidate) => (
            <InsetGroupedRow
              key={candidate}
              label={t(LOCALE_LABEL_KEY[candidate])}
              selected={locale === candidate}
              chevron={false}
              onClick={() => setLocale(candidate)}
            />
          ))}
        </InsetGroupedSection>
        <InsetGroupedSection caption={t("settings.appearance.themeTitle")}>
          {THEME_MODES.map((mode) => (
            <InsetGroupedRow
              key={mode}
              label={t(THEME_LABEL_KEY[mode])}
              selected={theme.mode === mode}
              chevron={false}
              onClick={() => theme.setMode(mode)}
            />
          ))}
        </InsetGroupedSection>
        <InsetGroupedSection caption={t("settings.appearance.accentTitle")}>
          <li>{accentSwatches}</li>
        </InsetGroupedSection>
        <InsetGroupedSection caption={t("settings.appearance.botAccentTitle")}>
          {BOT_ACCENT_MODES.map((mode) => (
            <InsetGroupedRow
              key={mode}
              label={t(BOT_ACCENT_LABEL_KEY[mode])}
              selected={botAccentMode === mode}
              chevron={false}
              onClick={() => setBotAccentMode(mode)}
            />
          ))}
        </InsetGroupedSection>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <SectionHeading
        title={t("settings.appearance.title")}
        description={t("settings.appearance.description")}
      />

      <SettingsCard>
        <CardHeading
          title={t("settings.appearance.languageTitle")}
          description={t("settings.appearance.languageDescription")}
        />
        <div className={`mt-4 ${ACTIONS}`}>
          {LOCALES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={locale === candidate}
              onClick={() => setLocale(candidate)}
              className={`rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                locale === candidate
                  ? "border-input bg-accent font-medium"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              {t(LOCALE_LABEL_KEY[candidate])}
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard>
        <CardHeading
          title={t("settings.appearance.themeTitle")}
          description={t("settings.appearance.themeDescription")}
        />
        <div className={`mt-4 ${ACTIONS}`}>
          {THEME_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={theme.mode === mode}
              onClick={() => theme.setMode(mode)}
              className={`rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                theme.mode === mode
                  ? "border-input bg-accent font-medium"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              {t(THEME_LABEL_KEY[mode])}
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard>
        <CardHeading
          title={t("settings.appearance.accentTitle")}
          description={t("settings.appearance.accentDescription")}
        />
        {accentSwatches}
      </SettingsCard>

      <SettingsCard>
        <CardHeading
          title={t("settings.appearance.botAccentTitle")}
          description={t("settings.appearance.botAccentDescription")}
        />
        <div className={`mt-4 ${ACTIONS}`}>
          {BOT_ACCENT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={botAccentMode === mode}
              onClick={() => setBotAccentMode(mode)}
              data-bot-accent-choice={mode}
              className={`rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                botAccentMode === mode
                  ? "border-input bg-accent font-medium"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              {t(BOT_ACCENT_LABEL_KEY[mode])}
            </button>
          ))}
        </div>
      </SettingsCard>

      {/* Bureau seulement : un téléphone garde la taille du texte du système. */}
      <SettingsCard>
        <CardHeading
          title={t("settings.appearance.textSizeTitle")}
          description={t("settings.appearance.textSizeDescription")}
        />
        <div className={`mt-4 ${ACTIONS}`}>
          {TEXT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={textSize === size}
              onClick={() => setTextSize(size)}
              data-text-size={size}
              className={`rounded-md border px-3 py-1.5 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                textSize === size
                  ? "border-input bg-accent font-medium"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              {t("settings.appearance.textSizeOption", { size })}
            </button>
          ))}
        </div>
      </SettingsCard>

      {/* Bureau seulement : sur téléphone, les réglages sont une pile d'écrans. */}
      <SettingsCard>
        <CardHeading
          title={t("settingsSidebar.displayLabel")}
          description={t("settingsSidebar.displayHint")}
        />
        <div className={`mt-4 ${ACTIONS}`}>
          {(["modal", "page"] as const).map((display) => (
            <button
              key={display}
              type="button"
              aria-pressed={settingsDisplay === display}
              onClick={() => chooseSettingsDisplay(display)}
              data-settings-display={display}
              className={`rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                settingsDisplay === display
                  ? "border-input bg-accent font-medium"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              {t(SETTINGS_DISPLAY_LABEL_KEY[display])}
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard>
        <CardHeading
          title={t("settings.appearance.layoutTitle")}
          description={t("settings.appearance.layoutDescription")}
        />
        <AccountLayoutPicker />
      </SettingsCard>
    </SettingsPane>
  );
}
