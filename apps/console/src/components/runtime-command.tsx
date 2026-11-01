import { useEffect, useState, type ReactNode } from "react";
import { cn, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { type MessageKey } from "../lib/i18n";
import { MobileActionFooter } from "./mobile/inset-grouped";
import { BUTTON } from "./settings/primitives";

/** Durée pendant laquelle le bouton affiche « Copié » avant de redevenir « Copier ». */
const COPIED_MS = 2000;

/** The copy gesture of a command: the button itself confirms, then rearms. */
function CopyCommandButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  // Le bouton lui-même dit que la copie a réussi (coche verte, « Copié »),
  // puis se réarme : un toast seul se perd sous une boîte de dialogue.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch (error) {
      setCopied(false);
      toast.error(
        `Impossible de copier : ${error instanceof Error ? error.message : "presse-papiers indisponible"}`,
      );
    }
  };

  return (
    <button
      type="button"
      className={cn(copied ? BUTTON.success : BUTTON.small, "shrink-0 px-2.5 py-1 text-xs")}
      onClick={() => void copy()}
      aria-label={copied ? `${label} copié` : `Copier ${label.toLowerCase()}`}
      aria-live="polite"
    >
      {copied ? (
        <>
          <IconCheck className="size-3.5" /> Copié
        </>
      ) : (
        <>
          <IconCopy className="size-3.5" /> Copier
        </>
      )}
    </button>
  );
}

export function EnrollmentStep({
  index,
  title,
  value,
  copyLabel,
  prefix,
  wrap = false,
  children,
}: {
  index: number;
  title: string;
  value: string;
  copyLabel: string;
  prefix?: string;
  wrap?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-2">
      <span aria-hidden className="pt-0.5 font-mono text-xs text-muted-foreground">{index}.</span>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="text-sm font-medium tracking-tight">{title}</h3>
        <CopyCommandButton value={value} label={copyLabel} />
      </div>
      <div className="col-start-2 flex gap-2 rounded-lg bg-surface-sunken px-3 py-2">
        {prefix ? <span aria-hidden className="font-mono text-xs leading-5 text-muted-foreground select-none">{prefix}</span> : null}
        <code
          className={cn(
            "scrollbar-subtle min-w-0 flex-1 font-mono text-xs leading-5",
            wrap ? "break-all" : "scrollbar-subtle block overflow-x-auto whitespace-pre",
          )}
        >
          {value}
        </code>
      </div>
      {children ? <div className="col-start-2 text-xs leading-5 text-muted-foreground">{children}</div> : null}
    </li>
  );
}



/**
 * Le pied d'un dialogue direct : à droite sur desktop, sans le canevas gris
 * de la feuille mobile (`MobileActionFooter` le pose sans condition, pensé
 * pour LA feuille mobile).
 */
export function DialogFooterRow({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileActionFooter>{children}</MobileActionFooter>;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
      {children}
    </div>
  );
}

/** Les commandes d'installation Debian/Ubuntu, une par étape, dans l'ordre d'exécution. */
export const INSTALL_COMMANDS: { title: MessageKey; value: string }[] = [
  {
    title: "runtimeDirect.installKeyring",
    value:
      "curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null",
  },
  {
    title: "runtimeDirect.installRepository",
    value:
      'echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list',
  },
  {
    title: "runtimeDirect.installPackage",
    value: "sudo apt-get update && sudo apt-get install -y cloudflared",
  },
  {
    title: "runtimeDirect.installService",
    value: "sudo cloudflared service install <JETON_DU_TUNNEL>",
  },
  {
    title: "runtimeDirect.installStatus",
    value: "systemctl status cloudflared --no-pager",
  },
];

type HostCommand = {
  label: string;
  value: string;
};

/**
 * Host commands an operator runs in the host's own console: a reference
 * list, not ordered steps, so no numbering. Each row keeps the copy gesture.
 */
export function HostCommandList({ commands }: { commands: HostCommand[] }) {
  return (
    <dl className="divide-y divide-border-table overflow-hidden rounded-xl border border-border-table">
      {commands.map((command) => (
        <div
          key={command.label}
          className="grid gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center"
        >
          <dt className="text-sm text-text-tertiary">{command.label}</dt>
          <dd className="min-w-0">
            <code className="scrollbar-subtle block overflow-x-auto rounded-lg bg-surface-sunken px-3 py-1.5 font-mono text-xs leading-5 whitespace-pre">
              {command.value}
            </code>
          </dd>
          <dd className="justify-self-start sm:justify-self-end">
            <CopyCommandButton value={command.value} label={command.label} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
