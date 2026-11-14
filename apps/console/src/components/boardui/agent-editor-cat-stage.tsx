import { cn } from "@openedbot/browser-ui-kit";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import {
  MASCOT_ACCESSORIES,
  MASCOT_EYE_STYLES,
  mascotFace,
  resolveMascot,
  type MascotAccessory,
} from "@openedbot/browser-face/mascot";
import { useT } from "../../lib/i18n";
import { BotFace } from "../bot-face";
import { ArcPicker } from "./agent-editor-arc-picker";

type Sign = { id: MascotAccessory | "none" };
const SIGNS: readonly Sign[] = [{ id: "none" }, ...MASCOT_ACCESSORIES.map((id) => ({ id }))];

/** The four eye styles, on an arc above the preview (degrees from the top). */
const EYE_ANGLES = [-54, -18, 18, 54] as const;

/**
 * The Cat tab: the openedbot mascot (`shape: "chat"`), the live preview in
 * the same place as the other tabs, its eye styles on an arc above it and
 * its job sign on the bottom arc. The colour is the shared pill under the
 * stage (`ColorPill` keeps the shape, so a cat stays a cat).
 */
export function CatStage({ seed, name, face, onFace }: { seed: string; name: string; face: BotFaceSpec; onFace: (face: BotFaceSpec) => void }) {
  const { t } = useT();
  const mascot = resolveMascot(face);
  const palette = mascot.colorId ?? face.palette;
  return (
    <div className="relative h-[360px] overflow-hidden">
      <div className="pointer-events-none absolute top-[30px] left-1/2 z-10 -translate-x-1/2">
        <div role="group" aria-label={t("boardui.catEyes")} className="relative size-[268px]">
          {MASCOT_EYE_STYLES.map((eyes, index) => {
            const angle = EYE_ANGLES[index]!;
            const selected = mascot.eyes === eyes;
            const label = t(`face.catEyes.${eyes}`);
            return (
              <div
                key={eyes}
                className="absolute top-1/2 left-1/2 -mt-[17px] -ml-[17px] size-[34px]"
                style={{ transform: `rotate(${angle}deg) translateY(-116px)` }}
              >
                <div style={{ transform: `rotate(${-angle}deg)` }}>
                  <button
                    type="button"
                    aria-label={label}
                    title={label}
                    aria-pressed={selected}
                    onClick={() => onFace(mascotFace(palette, eyes, mascot.accessory))}
                    className={cn(
                      "pointer-events-auto flex size-[34px] cursor-pointer items-center justify-center rounded-full bg-background-secondary-default outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                      selected ? "ring-2 ring-foreground-icon-secondary" : "hover:ring-2 hover:ring-border-button-hover",
                    )}
                  >
                    <BotFace name={label} seed={`cat-eyes:${eyes}`} face={mascotFace(palette, eyes, null)} animated={false} className="size-[26px]" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute top-[83px] left-1/2 -translate-x-1/2">
        <BotFace name={t("boardui.livePreview", { name })} seed={seed} face={face} className="size-[162px]" />
      </div>
      <ArcPicker
        label={t("boardui.catSign")}
        items={SIGNS}
        selectedId={mascot.accessory ?? "none"}
        itemLabel={(sign) => t(`face.catSigns.${sign.id}`)}
        onPick={(sign) => onFace(mascotFace(palette, mascot.eyes, sign.id === "none" ? null : sign.id))}
        renderItem={(sign) => (
          <BotFace
            name={t(`face.catSigns.${sign.id}`)}
            seed={`cat-sign:${sign.id}`}
            face={mascotFace(palette, mascot.eyes, sign.id === "none" ? null : sign.id)}
            animated={false}
            className="size-12"
          />
        )}
      />
    </div>
  );
}
