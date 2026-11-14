import { useState } from "react";
import { IconCopy } from "@tabler/icons-react";
import { cn, Dialog, Input, Label, toast } from "@openedbot/browser-ui-kit";
import { useT } from "../../../../lib/i18n";
import { BUTTON, Note } from "../../../../components/settings/primitives";

export function CopyableCommand({ label, value }: { label: string; value: string }) {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copiée.`);
    } catch (error) {
      toast.error(`Impossible de copier ${label.toLowerCase()} : ${error instanceof Error ? error.message : "presse-papiers indisponible"}`);
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <button type="button" className={BUTTON.small} onClick={() => void copy()} aria-label={`Copier ${label.toLowerCase()}`}>
          <IconCopy className="size-3.5" /> Copier
        </button>
      </div>
      <code className="scrollbar-subtle block max-w-full overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 text-xs leading-5">{value}</code>
    </div>
  );
}

/** The default path of the gateway environment, set by the operator tool. */
const RUNTIME_ENV_PATH = "/srv/hermes/data/runtime.env";
const RUNTIME_UNIT = "hermes-gateway.service";

function sshHostFromUrl(url: string): string {
  try {
    return new URL(url.trim()).hostname || "<hôte>";
  } catch {
    return "<hôte>";
  }
}

/**
 * Where to find the Hermes token, without openedbot going to fetch it.
 *
 * The bearer lives in the gateway environment, on the operator's host.
 * The application does not read it there and restarts nothing: administering this runtime
 * is not its role, and a route that could read a remote file would be
 * a permanent door. It therefore shows the commands, and the operator runs them.
 */
export function HermesTokenHelpDialog({ url, className }: { url: string; className?: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [sshUser, setSshUser] = useState("hermes-admin");
  const host = sshHostFromUrl(url);
  const target = `${sshUser.trim() || "<utilisateur>"}@${host}`;
  const readCommand =
    `ssh ${target} 'sudo -n sed -n "s/^API_SERVER_KEY=//p" ${RUNTIME_ENV_PATH} | head -1'`;
  // `--reference` keeps the owner and the mode of the existing file: an
  // installation that does not use the `hermes` user keeps its own, and
  // the gateway keeps reading its environment after the rotation.
  const createCommand = [
    `sudo sh -c 'umask 077;`,
    `f=${RUNTIME_ENV_PATH};`,
    `t=$(mktemp "$f.XXXXXX");`,
    `grep -v "^API_SERVER_KEY=" "$f" > "$t";`,
    `printf "API_SERVER_KEY=%s\\n" "$(openssl rand -hex 32)" >> "$t";`,
    `chown --reference="$f" "$t"; chmod --reference="$f" "$t";`,
    `mv -f "$t" "$f"'`,
  ].join(" ");
  return (
    <>
      {/*
        Framed like « Remplacer le token » and « Tester la connexion »: set bare beside
        them, it read as a caption and not as an action.
      */}
      <button type="button" className={cn(BUTTON.secondary, className)} onClick={() => setOpen(true)}>
        Où trouver le token ?
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("cloudRuntimeSettings.hermesTokenHelpTitle")}
        description={t("cloudRuntimeSettings.hermesTokenHelpDescription")}
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="hermes-token-help-user">Compte SSH d’administration</Label>
            <Input
              id="hermes-token-help-user"
              value={sshUser}
              onChange={(event) => setSshUser(event.target.value)}
              placeholder="hermes-admin"
            />
            <p className="text-xs text-muted-foreground">
              L’hôte <code>{host}</code> vient de l’URL Hermes saisie.
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold">1. Lire le token déjà en place</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Un runtime installé par l’outil opérateur en possède déjà un. Copiez la valeur renvoyée dans le champ « Token Hermes ».
              </p>
            </div>
            <CopyableCommand label="Lire le token" value={readCommand} />
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold">2. Si la commande ne renvoie rien : en créer un</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Connectez-vous à l’hôte (<code>ssh {target}</code>), puis jouez ces deux commandes. La première réécrit
                {" "}<code>{RUNTIME_ENV_PATH}</code> de façon atomique en conservant son propriétaire et son mode ; la
                seconde fait relire l’environnement au gateway.
              </p>
            </div>
            <CopyableCommand label="Générer et écrire la clé" value={createCommand} />
            <CopyableCommand label="Recharger le gateway" value={`sudo systemctl restart ${RUNTIME_UNIT}`} />
            <p className="text-xs leading-5 text-muted-foreground">
              Relancez ensuite la commande de lecture pour obtenir la nouvelle valeur.
            </p>
          </div>

          <Note tone="warning">
            <strong>Le token s’affiche dans votre terminal</strong>, il reste donc dans l’historique et le défilement.
            Effacez la ligne (<code>history -d</code>) une fois collée. Remplacer un token existant invalide
            immédiatement l’ancien : tout autre client qui l’utilise cessera de répondre.
          </Note>
        </div>
      </Dialog>
    </>
  );
}
