import type { BotFaceSpec } from "@openedbot/contracts-api";
import { cn, Label, ToggleGroup, ToggleGroupItem } from "@openedbot/browser-ui-kit";
import { COLORS, EXPRESSIONS, SHAPES, resolveFace } from "@openedbot/browser-face/presets";
import { PICKABLE_BOT_ARTWORKS, resolveBotArtwork } from "@openedbot/browser-face/artworks";
import { BloubBotFace } from "./bloub-bot";
import { BotFace } from "./bot-face";
import { useT } from "../lib/i18n";

/**
 * `ToggleGroup` refuse la chaîne vide comme valeur, l'absence d'artwork (le
 * visage classique) porte donc une sentinelle hors catalogue.
 */
const CUSTOM_FACE = "custom";

/**
 * L'apparence d'un bot dans la feuille de création (`bot-create/create-bot-sheet`),
 * sur le même catalogue (`@openedbot/browser-face/presets`) que l'éditeur d'agent
 * (`boardui/agent-editor-panel`), pour que les deux surfaces proposent les
 * mêmes visages.
 *
 * L'artwork WEBP prime (c'est lui que `BotFace` rend quand il est posé) : le
 * catalogue vient en premier, et les trois axes du visage classique, la
 * forme, la couleur et l'expression de repos du personnalisateur bloub,
 * n'apparaissent qu'en mode « visage personnalisé ».
 *
 * Les VIGNETTES sont figées (`animated={false}`), seul l'aperçu du bot vit.
 * C'est le seul endroit du produit où le choix se justifie : trente frimousses
 * qui respirent pendant qu'on en désigne une, c'est trente choses qui bougent
 * pour une décision, et l'œil ne sait plus laquelle il regarde. Ailleurs, une
 * pastille est quelqu'un ; ici, c'est une option.
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
