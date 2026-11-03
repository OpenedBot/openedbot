/** Export portable et borné de l'équipe active, sans état runtime ni secret. */
export type TeamMarkdownExportDto = {
  format: "openmaus.botmrr";
  version: 1;
  teamName: string;
  sourceId: string;
  release: string;
  fileName: string;
  contentType: "text/markdown";
  markdown: string;
  counts: { bots: number; groups: number; routines: number; playbooks: number };
  /** Éléments volontairement omis ou projetés par défaut, aussi inscrits dans le Markdown. */
  limitations: string[];
};
