import { shellWords } from "@openedbot/roster/domain/editor-directives";

/**
 * Each blocklist entry is a command prefix of words (`git push --force`). A
 * command matches when one of its segments starts with those words, past
 * variable assignments and `sudo`. `null`: the command cannot be read.
 */
export function commandMatchesBlocklist(command: string, blocklist: readonly string[]): boolean | null {
  const patterns = blocklist.map((entry) => shellWords(entry.trim())).filter((words): words is string[] => !!words && words.length > 0);
  for (const segment of command.split(/\s*(?:&&|\|\||[;\n|]|\$\(|`)\s*/)) {
    if (!segment.trim()) continue;
    const words = shellWords(segment.trim());
    if (words === null) return null;
    let start = 0;
    while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? "")) start += 1;
    if (words[start] === "sudo" || words[start] === "command") start += 1;
    const head = words.slice(start).map((word, index) => (index === 0 ? word.split("/").pop() ?? word : word));
    if (patterns.some((pattern) => pattern.every((word, index) => head[index] === word))) return true;
  }
  return false;
}
