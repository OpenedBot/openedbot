import type { BotFaceSpec } from "@openedbot/contracts-api";
import { cn, Label, ToggleGroup, ToggleGroupItem } from "@openedbot/browser-ui-kit";
import { COLORS, EXPRESSIONS, SHAPES, resolveFace } from "@openedbot/browser-face/presets";
import { PICKABLE_BOT_ARTWORKS, resolveBotArtwork } from "@openedbot/browser-face/artworks";
import { BloubBotFace } from "./bloub-bot";
import { BotFace } from "./bot-face";
import { useT } from "../lib/i18n";

/**
 * `ToggleGroup` refuses the empty string as a value, so the absence of artwork (the
 * classic face) carries a sentinel outside the catalogue.
 */
const CUSTOM_FACE = "custom";

/**
 * A bot's appearance in the creation sheet (`bot-create/create-bot-sheet`),
 * on the same catalogue (`@openedbot/browser-face/presets`) as the agent editor
 * (`boardui/agent-editor-panel`), so the two surfaces offer the
 * same faces.
 *
 * The WEBP artwork wins (it is what `BotFace` renders when it is set): the
 * catalogue comes first, and the classic face's three axes, the
 * shape, the colour and the idle expression of the bloub customizer,
 * appear only in « visage personnalisé » mode.
 *
 * The THUMBNAILS are frozen (`animated={false}`), only the bot's preview lives.
 * It is the only place in the product where the choice is justified: thirty faces
 * breathing while one points at one of them is thirty things moving
 * for one decision, and the eye no longer knows which it is looking at. Elsewhere, a
 * chip is someone; here, it is an option.
 */
export function FaceFields({
  face,
  onChange,
}: {
  face: BotFaceSpec;
  onChange: (next: BotFaceSpec) => void;
}) {
  const { t } = useT();

  const artwork = resolveBotArtwork(face.artwork);

  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{t("newBotDialog.artworkLabel")}</Label>
        <ToggleGroup
          type="single"
          value={artwork?.id ?? CUSTOM_FACE}
          onValueChange={(value) => {
            if (!value) return;
            const { artwork: _cleared, ...rest } = face;
            onChange(value === CUSTOM_FACE ? rest : { ...rest, artwork: value });
          }}
          className="w-full flex-wrap justify-start gap-1"
          aria-label={t("newBotDialog.artworkLabel")}
        >
          {PICKABLE_BOT_ARTWORKS.map((option) => (
            <ToggleGroupItem
              key={option.id}
              value={option.id}
              aria-label={option.name}
              title={option.name}
              className={cn(
                "size-10 p-1 data-[state=on]:ring-2 data-[state=on]:ring-ring",
                option.portrait && "rounded-2xl",
              )}
            >
              <img
                src={`/bots/bot-${option.id}.webp`}
                alt=""
                className={cn(
                  "size-8 shrink-0",
                  option.portrait ? "rounded-xl object-cover" : "object-contain",
                )}
              />
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem value={CUSTOM_FACE} aria-label={t("newBotDialog.artworkCustom")} title={t("newBotDialog.artworkCustom")} className="size-10 p-1 data-[state=on]:ring-2 data-[state=on]:ring-ring">
            <BotFace name={t("newBotDialog.artworkCustom")} seed={CUSTOM_FACE} face={{ ...face, artwork: undefined }} animated={false} className="size-8" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {artwork ? null : (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("newBotDialog.shapeLabel")}</Label>
            <ToggleGroup type="single" value={face.shape} onValueChange={(value) => value && onChange({ ...face, shape: value })} className="w-full flex-wrap justify-start gap-1" aria-label={t("newBotDialog.shapeLabel")}>
              {SHAPES.map((shape) => {
                const name = t(`face.shapes.${shape.id}`);
                return (
                  <ToggleGroupItem key={shape.id} value={shape.id} aria-label={name} title={name} className="size-10 p-1 data-[state=on]:ring-2 data-[state=on]:ring-ring">
                    <BloubBotFace face={resolveFace({ ...face, shape: shape.id })} seed={shape.id} animated={false} className="size-9" />
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("newBotDialog.colorLabel")}</Label>
            <ToggleGroup type="single" value={face.palette} onValueChange={(value) => value && onChange({ ...face, palette: value })} className="w-full flex-wrap justify-start gap-1" aria-label={t("newBotDialog.colorLabel")}>
              {COLORS.map((color) => {
                const name = t(`face.colors.${color.id}`);
                return (
                  <ToggleGroupItem key={color.id} value={color.id} aria-label={name} title={name} className="size-10 p-1 data-[state=on]:ring-2 data-[state=on]:ring-ring">
                    <span aria-hidden className="size-7 rounded-full border border-border/50" style={{ backgroundColor: color.hex }} />
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("newBotDialog.expressionLabel")}</Label>
            <ToggleGroup type="single" value={face.eyes} onValueChange={(value) => value && onChange({ ...face, eyes: value })} className="w-full flex-wrap justify-start gap-1" aria-label={t("newBotDialog.expressionLabel")}>
              {EXPRESSIONS.map((expression) => {
                const name = t(`face.expressions.${expression.id}`);
                return (
                  <ToggleGroupItem key={expression.id} value={expression.id} aria-label={name} title={name} className="size-10 p-1 data-[state=on]:ring-2 data-[state=on]:ring-ring">
                    <BloubBotFace face={resolveFace({ ...face, eyes: expression.id })} seed={expression.id} animated={false} className="size-9" />
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
        </>
      )}
    </>
  );
}
