import { ACCENTS, ACCENT_SWATCHES, THEME_MODES, useTheme, type AccentId } from "@openedbot/browser-ui-kit/theme";
import { LOCALES } from "@openedbot/contracts-locale";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useT, type Locale, type MessageKey } from "../../../lib/i18n";
import { CardHeading, ListRow, ListSection, SectionHeading, SettingsCard } from "../../../components/settings/primitives";
import { Segmented } from "../../../components/settings/segmented";
import { AccountLayoutPicker } from "../../../components/settings/account-layout-picker";
import { InsetGroupedRow, InsetGroupedSection } from "../../../components/mobile/inset-grouped";
import { SettingsPane } from "../pane";
import { TEXT_SIZES, setTextSize, useTextSize } from "../../../lib/shell/text-size";
import { BOT_ACCENT_MODES, setBotAccentMode, useBotAccentMode, type BotAccentMode } from "../../../lib/bots/bot-accent-preference";

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

  const accentSwatches = (
    <div className={isMobile ? "flex flex-wrap gap-3 px-4 py-3" : "flex flex-wrap justify-end gap-2"}>
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

  // Bureau : les réglages courts regroupés en deux listes, une ligne par
  // réglage, le libellé à gauche et la commande à droite sur la même ligne
  // (au lieu d'une carte par réglage, la commande seule sur sa rangée).
  return (
    <SettingsPane>
      <SectionHeading
        title={t("settings.appearance.title")}
        description={t("settings.appearance.description")}
      />

      <ListSection title={t("settings.appearance.interfaceTitle")}>
        <ListRow label={t("settings.appearance.languageTitle")} description={t("settings.appearance.languageDescription")}>
          <Segmented
            label={t("settings.appearance.languageTitle")}
            options={LOCALES.map((candidate) => ({ id: candidate, label: t(LOCALE_LABEL_KEY[candidate]) }))}
            value={locale}
            onChange={setLocale}
          />
        </ListRow>
        <ListRow label={t("settings.appearance.themeTitle")} description={t("settings.appearance.themeDescription")}>
          <Segmented
            label={t("settings.appearance.themeTitle")}
            options={THEME_MODES.map((mode) => ({ id: mode, label: t(THEME_LABEL_KEY[mode]) }))}
            value={theme.mode}
            onChange={theme.setMode}
          />
        </ListRow>
        {/* Bureau seulement : un téléphone garde la taille du texte du système. */}
        <ListRow label={t("settings.appearance.textSizeTitle")} description={t("settings.appearance.textSizeDescription")}>
          <Segmented
            label={t("settings.appearance.textSizeTitle")}
            options={TEXT_SIZES.map((size) => ({ id: size, label: t("settings.appearance.textSizeOption", { size }), data: { "data-text-size": size } }))}
            value={textSize}
            onChange={setTextSize}
            numeric
          />
        </ListRow>
      </ListSection>

      <ListSection title={t("settings.appearance.colorsTitle")}>
        <ListRow label={t("settings.appearance.accentTitle")} description={t("settings.appearance.accentDescription")}>
          {accentSwatches}
        </ListRow>
        <ListRow label={t("settings.appearance.botAccentTitle")} description={t("settings.appearance.botAccentDescription")}>
          <Segmented
            label={t("settings.appearance.botAccentTitle")}
            options={BOT_ACCENT_MODES.map((mode) => ({ id: mode, label: t(BOT_ACCENT_LABEL_KEY[mode]), data: { "data-bot-accent-choice": mode } }))}
            value={botAccentMode}
            onChange={setBotAccentMode}
          />
        </ListRow>
      </ListSection>

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
