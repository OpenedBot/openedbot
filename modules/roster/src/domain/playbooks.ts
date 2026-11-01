export const PLAYBOOK_RENDER_MAX_CHARS = 24_000;
export const PLAYBOOK_MAX_SELECTED = 3;
export const SECTION_CONTEXT_MAX_CHARS = 24_000;

export type PlaybookMatch = {
  key: string;
  name: string;
  summary: string;
  triggers: readonly string[];
  instructions: string;
};

export function selectPlaybooksForTurn(
  playbooks: readonly PlaybookMatch[],
  input: string,
  max = PLAYBOOK_MAX_SELECTED,
): PlaybookMatch[] {
  const haystack = input.toLowerCase();
  const matched = playbooks.filter((playbook) =>
    playbook.triggers.some((trigger) => {
      const needle = trigger.trim().toLowerCase();
      return needle.length > 0 && haystack.includes(needle);
    }),
  );
  return matched.slice(0, max);
}

/**
 * Playbooks matching the current turn. Variable, never part of the stable
 * persona+memory prefix. A playbook grants no tools, no apps, no right to
 * override an approval.
 */
export function buildPlaybookBlock(playbooks: readonly PlaybookMatch[]): string {
  if (playbooks.length === 0) return "";
  const rendered: string[] = [
    "## Playbooks",
    "",
    "Process guidance selected for this turn because a trigger term appeared in the current job. These playbooks grant no tools, apps, permissions, or authority to override approvals.",
    "",
  ];
  let used = rendered.join("\n").length;
  for (const playbook of playbooks) {
    const block = [
      `### ${playbook.name} (${playbook.key})`,
      playbook.summary,
      playbook.triggers.length ? `Use when: ${playbook.triggers.join(", ")}` : "",
      playbook.instructions,
      "",
    ].filter((line) => line !== "").join("\n");
    if (used + block.length + 1 > PLAYBOOK_RENDER_MAX_CHARS) break;
    rendered.push(block);
    used += block.length + 1;
  }
  return rendered.join("\n").trimEnd();
}

/** Operator-owned team brief. Same for every bot in the section. Not agent-writable. */
export function buildSectionContextBlock(context: string): string {
  const trimmed = context.trim().slice(0, SECTION_CONTEXT_MAX_CHARS);
  if (!trimmed) return "";
  return [
    "## Team brief",
    "",
    "Shared operator-owned brief for every bot in this section. You cannot change it.",
    "",
    trimmed,
  ].join("\n");
}
