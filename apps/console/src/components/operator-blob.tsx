import type { BotFaceSpec } from "@openedbot/contracts-api";
import { BotFace } from "./bot-face";

const OPERATOR_FACE: BotFaceSpec = {
  palette: "bleu",
  shape: "galet",
  eyes: "neutre",
};

/**
 * The operator's face. Its own module: the account menu shows it on every
 * screen, and importing it from the settings dialog dragged every settings
 * screen into the first load.
 *
 * Alive by default. `animated={false}` freezes it on the shared clock's
 * current pose, for a copy that only shows for a moment (the account menu's
 * header): a second live face there cost an engine sample per frame while
 * the menu opened.
 */
export function OperatorBlob({
  name,
  className,
  animated = true,
}: {
  name: string;
  className?: string;
  animated?: boolean;
}) {
  return (
    <BotFace
      name={name}
      seed="operator"
      face={OPERATOR_FACE}
      animated={animated}
      className={className}
    />
  );
}
