/** An MCP plugin's chip: its initial on a 24 px tile. */
export function PluginBadge({ name }: { name: string }) {
  return (
    <span aria-hidden className="openedbot-mcp-letter flex size-6 shrink-0 items-center justify-center rounded-md bg-background-tertiary-default text-caption-1-semibold text-text-primary">
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
