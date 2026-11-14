/** Portable, bounded export of the active team, with no runtime state and no secret. */
export type TeamMarkdownExportDto = {
  format: "openedbot.team-markdown";
  version: 1;
  teamName: string;
  sourceId: string;
  release: string;
  fileName: string;
  contentType: "text/markdown";
  markdown: string;
  counts: { bots: number; groups: number; routines: number; playbooks: number };
  /** Items deliberately omitted or projected by default, also written into the Markdown. */
  limitations: string[];
};
