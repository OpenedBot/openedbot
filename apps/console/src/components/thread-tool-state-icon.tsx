import {
  AlertTriangle,
  BookOpen,
  Braces,
  FileSearch,
  FileText,
  Globe,
  List,
  Loader2,
  PencilLine,
  Plug,
  Search,
  Split,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { toolKind, type ToolKind } from "@openedbot/conversation/domain/thread-tools";

/** The glyph of a tool family, as the Agent Activity feed draws it. */
const KIND_ICONS: Record<ToolKind, LucideIcon> = {
  search: Search,
  web: Globe,
  read: FileText,
  edit: PencilLine,
  run: SquareTerminal,
  code: Braces,
  delegate: Split,
  mcp: Plug,
  other: Wrench,
};

/**
 * A few tools read better with their own glyph than with their family's.
 * A `Map`, not an object literal: tool names come from the runtime and from
 * MCP servers, and a tool named `constructor` must not resolve to `Object`.
 */
const TOOL_ICONS: ReadonlyMap<string, LucideIcon> = new Map<string, LucideIcon>([
  ["skill_view", BookOpen],
  ["skills_list", List],
  ["search_files", FileSearch],
]);

export function toolKindIcon(tool: string): LucideIcon {
  const bare = tool.replace(/^mcp__.+?__/, "");
  return TOOL_ICONS.get(bare) ?? KIND_ICONS[toolKind(tool)];
}

/** Le type d'outil reste visible en succès, son état ressort en attente ou en échec. */
export function ToolStateIcon({ done, failed, partial = false, tool = null }: {
  done: boolean;
  failed: boolean;
  partial?: boolean;
  tool?: string | null;
}) {
  // Une réussite partielle ne peint pas tout le groupe en rouge.
  if (partial) return <AlertTriangle className="size-3.5 shrink-0 text-warn-700" aria-hidden />;
  if (failed) return <X className="size-3.5 shrink-0 text-destructive-text" aria-hidden />;
  if (!done) return <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />;
  const Icon = tool ? toolKindIcon(tool) : Wrench;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}
