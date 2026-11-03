import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import type { useT } from "../i18n";

type T = ReturnType<typeof useT>["t"];

const text = (value: unknown, max = 160): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

function pathList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const paths = value.map((item) => text(item)).filter((item): item is string => item !== null);
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} (+${paths.length - 3})` : shown;
}

/**
 * The console's own sentence for a proven plugin gate (`toolKey` set by the
 * API only when the host descriptor was verified). The host plugin text is
 * English and says nothing the descriptor does not: `null` for a terminal or
 * unidentified gate, which keeps the raw text.
 */
export function gatePhrase(approval: Pick<ApprovalRequestDto, "kind" | "toolKey" | "gateArgs">, t: T): string | null {
  const key = approval.toolKey;
  if (!key) return null;
  const tool = approval.kind.trim() || key;
  const args = approval.gateArgs ?? {};
  switch (key) {
    case "write_file": {
      const path = text(args.path);
      return path ? t("gateCard.phraseWriteFile", { tool, path }) : t("gateCard.phraseWriteFileBare", { tool });
    }
    case "patch": {
      const paths = pathList(args.paths);
      return paths ? t("gateCard.phrasePatch", { tool, paths }) : t("gateCard.phrasePatchBare", { tool });
    }
    case "skill_manage": {
      const name = text(args.name, 128);
      return name ? t("gateCard.phraseSkill", { tool, name }) : t("gateCard.phraseSkillBare", { tool });
    }
    case "send_message": {
      const target = text(args.target, 256);
      return target ? t("gateCard.phraseSendMessage", { tool, target }) : t("gateCard.phraseSendMessageBare", { tool });
    }
    case "cronjob":
      return t("gateCard.phraseCronjob", { tool });
    case "execute_code": {
      const language = text(args.language, 32);
      return language ? t("gateCard.phraseExecuteCode", { tool, language }) : t("gateCard.phraseExecuteCodeBare", { tool });
    }
    default:
      return t("gateCard.phraseGeneric", { tool });
  }
}
