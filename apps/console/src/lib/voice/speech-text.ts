export function markdownToSpeechText(markdown: string, locale: "fr" | "en"): string {
  const codeBlock = locale === "fr" ? "Bloc de code." : "Code block.";
  const image = locale === "fr" ? "Image" : "Image";
  const link = locale === "fr" ? "Lien vers" : "Link to";
  return markdown
    .replace(/```[^\n]*(?:\n[\s\S]*?(?:```|$))/g, `\n${codeBlock}\n`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => `${image}${alt.trim() ? ` : ${alt.trim()}` : ""}.`)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)]+/g, (value) => {
      try {
        return `${link} ${new URL(value).hostname}.`;
      } catch {
        return link;
      }
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/gm, " ")
    .replace(/\|/g, ", ")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
