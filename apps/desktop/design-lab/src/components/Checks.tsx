import type { LayoutCheck } from "../lib/preview";

export function ChecksBadge({ checks }: { checks: LayoutCheck[] | undefined }) {
  if (!checks) return <span className="badge">…</span>;
  const failed = checks.filter((check) => !check.ok);
  return failed.length === 0 ? (
    <span className="badge badge-ok" title="Tous les contrôles de mise en page passent">OK</span>
  ) : (
    <span className="badge badge-ko" title={failed.map((check) => check.label).join("\n")}>
      {failed.length} problème{failed.length > 1 ? "s" : ""}
    </span>
  );
}

export function ChecksList({ checks }: { checks: LayoutCheck[] | undefined }) {
  if (!checks) return null;
  return (
    <ul className="checks">
      {checks.map((check) => (
        <li key={check.label} data-ok={check.ok}>
          {check.ok ? "✓" : "✗"} {check.label}
        </li>
      ))}
    </ul>
  );
}
