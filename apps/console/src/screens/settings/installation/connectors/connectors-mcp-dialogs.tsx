import { useId, useState } from "react";
import { Dialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openedbot/browser-ui-kit";
import type { RuntimeIntegrationMcpCatalogEntryDto } from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import { BUTTON } from "../../../../components/settings/primitives";

export type AddInput = { name: string; url: string; auth: "none" | "header" | "oauth"; token?: string };

/**
 * Ajouter un serveur https, dans une boîte à part.
 *
 * Le formulaire ne propose PAS de serveur stdio : ajouter un serveur en
 * commande locale, c'est nommer un exécutable et son argv, et le lien ne porte
 * rien de tel vers la machine du client. Les serveurs en commande locale
 * arrivent par le catalogue approuvé, dont l'hôte détient la liste.
 */
export function McpAddDialog({
  open,
  busy,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: AddInput) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<AddInput["auth"]>("none");
  const [token, setToken] = useState("");
  const formId = useId();
  // Les mêmes bornes que l'API et que l'hôte, rejouées ici pour que le refus
  // arrive avant l'aller réseau, jamais à leur place.
  const valid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
    && url.startsWith("https://")
    && (auth !== "header" || token.length > 0);

  const close = () => {
    // Un jeton ne survit pas à la fermeture, même annulée : il n'a aucune
    // raison de rester en mémoire d'un composant que l'on rouvrira.
    setToken("");
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("connectorsSettings.mcpAddTitle")}
      description={t("connectorsSettings.mcpAddDescription")}
      closeLabel={t("common.close")}
      footer={
        <>
          <button type="button" className={BUTTON.secondary} onClick={close}>{t("common.cancel")}</button>
          <button type="submit" className={BUTTON.primary} form={formId} disabled={!valid || busy}>
            {pending ? t("connectorsSettings.mcpAdding") : t("connectorsSettings.mcpAdd")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || busy) return;
          onSubmit({ name, url, auth, ...(auth === "header" ? { token } : {}) });
          setToken("");
        }}
      >
        <Field label={t("connectorsSettings.mcpFieldName")} hint={t("connectorsSettings.mcpFieldNameHint")}>
          {(field) => (
            <input
              {...field}
              className={FIELD}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              data-dialog-autofocus=""
            />
          )}
        </Field>
        <Field label={t("connectorsSettings.mcpFieldUrl")}>
          {(field) => (
            <input
              {...field}
              className={FIELD}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://"
            />
          )}
        </Field>
        <Field label={t("connectorsSettings.mcpFieldAuth")}>
          {(field) => (
            <Select value={auth} onValueChange={(value) => setAuth(value as AddInput["auth"])}>
              <SelectTrigger {...field} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("connectorsSettings.mcpAuthNone")}</SelectItem>
                <SelectItem value="header">{t("connectorsSettings.mcpAuthHeader")}</SelectItem>
                <SelectItem value="oauth">{t("connectorsSettings.mcpAuthOauth")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        {auth === "header" ? (
          <Field label={t("connectorsSettings.mcpFieldToken")} hint={t("connectorsSettings.mcpFieldTokenHint")}>
            {(field) => (
              <input
                {...field}
                className={FIELD}
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * Brancher une entrée du catalogue : la boîte de saisie de ses variables.
 *
 * `entry` porte l'ouverture : une entrée non nulle est une boîte ouverte, et
 * la clé du formulaire la remonte, de sorte que passer d'une entrée à l'autre
 * ne traîne pas les valeurs tapées pour la précédente.
 */
export function McpInstallDialog({
  entry,
  busy,
  pending,
  onClose,
  onSubmit,
}: {
  entry: RuntimeIntegrationMcpCatalogEntryDto | null;
  busy: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (env: Record<string, string>) => void;
}) {
  const { t } = useT();
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  /**
   * Les variables appartiennent à L'ENTRÉE : passer d'un serveur du catalogue
   * à un autre ne doit pas traîner la saisie du précédent, et un secret ne
   * reste pas en mémoire une fois la boîte fermée.
   *
   * Remise à zéro pendant le RENDU, pas dans un effet : c'est un état dérivé
   * d'une prop, et React le recalcule dans la passe qui suit le clic, sans
   * peindre une seule fois les champs de l'entrée précédente.
   */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const openFor = entry?.name ?? null;
  if (openFor !== openedFor) {
    setOpenedFor(openFor);
    setValues({});
  }
  const ready = (entry?.envSpecs ?? [])
    .filter((spec) => spec.required)
    .every((spec) => (values[spec.name] ?? "").length > 0);

  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      title={entry ? t("connectorsSettings.mcpInstallTitle", { name: entry.name }) : ""}
      description={entry?.description || undefined}
      closeLabel={t("common.close")}
      // Les CTA vivent dans la barre du bas, pas dans le défilement du
      // formulaire : le bouton d'envoi rejoint son `<form>` par `form=`.
      // Le pied suit le formulaire : sans `entry`, il n'y a plus rien à
      // envoyer, et une barre d'actions seule survivrait au corps le temps
      // que la feuille glisse dehors.
      footer={
        entry ? (
          <>
            <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" className={BUTTON.primary} form={formId} disabled={!ready || busy}>
              {pending ? t("connectorsSettings.mcpInstalling") : t("connectorsSettings.mcpInstall")}
            </button>
          </>
        ) : null
      }
    >
      {entry ? (
        <form
          id={formId}
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || busy) return;
            onSubmit(values);
          }}
        >
          <p className="text-sm leading-6 text-muted-foreground">
            {t(entry.envSpecs.length > 0
              ? "connectorsSettings.mcpInstallDescription"
              : entry.authType === "oauth"
                ? "connectorsSettings.mcpInstallOauthDescription"
                : "connectorsSettings.mcpInstallNoValuesDescription")}
          </p>
          {entry.envSpecs.map((spec, index) => (
            <Field key={spec.name} label={spec.name} hint={spec.description ?? undefined}>
              {(field) => (
                <input
                  {...field}
                  className={FIELD}
                  // Une variable déclarée secrète ne s'affiche pas en clair,
                  // même le temps de la frappe : elle part vers le `.env` de
                  // l'hôte et n'en revient jamais.
                  type={spec.secret ? "password" : "text"}
                  value={values[spec.name] ?? ""}
                  onChange={(event) => setValues({ ...values, [spec.name]: event.target.value })}
                  autoComplete="off"
                  {...(index === 0 ? { "data-dialog-autofocus": "" } : {})}
                />
              )}
            </Field>
          ))}
        </form>
      ) : null}
    </Dialog>
  );
}

const FIELD = "min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Un champ dont le nom accessible est le LIBELLÉ, pas le libellé suivi de son
 * aide : un `<label>` englobant fait de tout son contenu le nom du champ, et
 * un lecteur d'écran annonce alors la phrase entière à chaque tabulation.
 * L'aide passe donc par `aria-describedby`, qui est lu à part.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: { id: string; "aria-describedby"?: string }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-muted-foreground" htmlFor={id}>{label}</label>
      {children(hint ? { id, "aria-describedby": hintId } : { id })}
      {hint ? <span id={hintId} className="block text-xs leading-4 text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
