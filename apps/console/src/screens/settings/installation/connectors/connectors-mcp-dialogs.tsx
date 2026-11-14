import { useId, useState } from "react";
import { Dialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openedbot/browser-ui-kit";
import type { RuntimeIntegrationMcpCatalogEntryDto } from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import { BUTTON } from "../../../../components/settings/primitives";

export type AddInput = { name: string; url: string; auth: "none" | "header" | "oauth"; token?: string };

/**
 * Add an https server, in a box of its own.
 *
 * The form does NOT offer a stdio server: adding a server as a
 * local command means naming an executable and its argv, and the link carries
 * nothing of the sort toward the client's machine. Local-command servers
 * arrive through the approved catalog, whose list the host holds.
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
  // The same bounds as the API and the host, replayed here so the refusal
  // arrives before the network round trip, never in their place.
  const valid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
    && url.startsWith("https://")
    && (auth !== "header" || token.length > 0);

  const close = () => {
    // A token does not survive closing, even a cancelled one: it has no
    // reason to stay in the memory of a component that will be reopened.
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
 * Wire a catalog entry: the input box for its variables.
 *
 * `entry` carries the opening: a non-null entry is an open box, and
 * the form's key remounts it, so that going from one entry to another
 * does not drag along the values typed for the previous one.
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
   * The variables belong to THE ENTRY: going from one catalog server
   * to another must not drag along the previous input, and a secret does not
   * stay in memory once the box is closed.
   *
   * Reset during RENDER, not in an effect: it is state derived
   * from a prop, and React recomputes it in the pass that follows the click, without
   * painting the previous entry's fields even once.
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
      // The CTAs live in the bottom bar, not in the form's
      // scroll: the submit button joins its `<form>` through `form=`.
      // The foot follows the form: without `entry`, there is nothing left to
      // send, and an action bar alone would outlive the body for as long as
      // the sheet slides out.
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
                  // A variable declared secret is not shown in the clear,
                  // not even while it is typed: it leaves for the host's `.env`
                  // and never comes back from it.
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
 * A field whose accessible name is the LABEL, not the label followed by its
 * help: a wrapping `<label>` makes all of its content the field's name, and
 * a screen reader then announces the whole sentence on every tab.
 * The help therefore goes through `aria-describedby`, which is read apart.
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
