/**
 * Mermaid in the app's colours, light and dark. Measured 2026-11-11: the
 * default `base` theme drew cream boxes with black labels on the dark
 * thread, and the same drawing whatever the app's theme.
 *
 * Mermaid derives its shades from concrete colours (khroma), so these are
 * the shadcn neutrals of `browser/ui-kit/src/styles/app.css`, not CSS
 * variables. The iOS app draws with the same values
 * (openedbot-mobile `App/openedbot/Features/Conversation/Mermaid/mermaid-render.js`).
 */
const LIGHT = {
  background: "transparent",
  surface: "#ffffff",
  raised: "#f5f5f5",
  border: "#d4d4d4",
  text: "#171717",
  muted: "#525252",
  line: "#737373",
  accent: "#e5e5e5",
} as const;

const DARK = {
  background: "transparent",
  surface: "#1f1f1f",
  raised: "#262626",
  border: "#404040",
  text: "#f5f5f5",
  muted: "#a3a3a3",
  line: "#a3a3a3",
  accent: "#333333",
} as const;

export function mermaidConfig(dark: boolean) {
  const c = dark ? DARK : LIGHT;
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    darkMode: dark,
    fontFamily: "Inter, -apple-system, sans-serif",
    themeVariables: {
      darkMode: dark,
      fontFamily: "Inter, -apple-system, sans-serif",
      fontSize: "13px",
      background: c.background,
      // Nodes, class boxes, states.
      primaryColor: c.surface,
      mainBkg: c.surface,
      nodeBkg: c.surface,
      primaryBorderColor: c.border,
      nodeBorder: c.border,
      primaryTextColor: c.text,
      textColor: c.text,
      classText: c.text,
      titleColor: c.text,
      secondaryColor: c.raised,
      secondaryBorderColor: c.border,
      secondaryTextColor: c.text,
      tertiaryColor: c.raised,
      tertiaryBorderColor: c.border,
      tertiaryTextColor: c.text,
      clusterBkg: c.raised,
      clusterBorder: c.border,
      // Edges and their labels.
      lineColor: c.line,
      edgeLabelBackground: dark ? DARK.surface : LIGHT.surface,
      // Sequence diagrams.
      actorBkg: c.surface,
      actorBorder: c.border,
      actorTextColor: c.text,
      actorLineColor: c.line,
      signalColor: c.line,
      signalTextColor: c.text,
      labelBoxBkgColor: c.raised,
      labelBoxBorderColor: c.border,
      labelTextColor: c.text,
      loopTextColor: c.muted,
      noteBkgColor: c.raised,
      noteBorderColor: c.border,
      noteTextColor: c.text,
      activationBkgColor: c.accent,
      activationBorderColor: c.border,
      sequenceNumberColor: dark ? LIGHT.text : DARK.text,
    },
    // Rounded boxes and lighter labels, as the app's cards.
    themeCSS: `
      .node rect, .classGroup rect, rect.actor, .basic.label-container { rx: 6px; ry: 6px; }
      .edgeLabel, .edgeLabel p, .edgeLabel rect { background-color: ${c.surface}; fill: ${c.surface}; color: ${c.muted}; }
      .edgeLabel span, .edgeLabel text { color: ${c.muted}; fill: ${c.muted}; font-size: 12px; }
      .classTitle, .nodeLabel strong { font-weight: 600; }
      .divider { stroke: ${c.border}; }
    `,
  };
}
