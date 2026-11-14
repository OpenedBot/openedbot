import { useT, type MessageKey } from "../lib/i18n";
import { BUTTON, Note } from "./settings/primitives";

const CREDENTIALS_URL = "https://login.tailscale.com/admin/settings/oauth";
const DOCS = "https://tailscale.com/docs/features/oauth-clients";

function GuideList({ items }: { items: MessageKey[] }) {
  const { t } = useT();
  return <ol className="list-decimal space-y-3 pl-6 marker:font-semibold">{items.map((key) => <li key={key} className="pl-1 leading-relaxed">{t(key)}</li>)}</ol>;
}

/**
 * The OAuth client that assisted Funnel publishing requires, distinct from the
 * pairing key openedbot will create afterwards.
 *
 * The order of the steps is not cosmetic: Tailscale requires that a tagged
 * pairing key carry exactly the tags of the OAuth client that creates it, and
 * a tag can be set on a client only if it already exists in
 * `tagOwners`. The tag is therefore declared BEFORE the client.
 */
export function TailscaleOauthGuide() {
  const { t } = useT();
  return (
    <section className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <h4 className="font-semibold">{t("tailscaleGuide.title")}</h4>
      <div className="flex flex-wrap gap-2">
        <a href="https://login.tailscale.com/admin/acls/file" target="_blank" rel="noopener noreferrer" className={BUTTON.secondary}>{t("tailscaleGuide.openPolicy")}</a>
        <a href={CREDENTIALS_URL} target="_blank" rel="noopener noreferrer" className={BUTTON.secondary}>{t("tailscaleGuide.openCredentials")}</a>
      </div>
      <GuideList items={["tailscaleGuide.step1"]} />
      <p>{t("tailscaleGuide.scopesIntro")}</p>
      <ul className="list-disc space-y-2 pl-6 break-words">
        <li>auth_keys → Write</li>
        <li>policy_file → Write</li>
        <li>devices → Write</li>
      </ul>
      <GuideList items={["tailscaleGuide.step2", "tailscaleGuide.step3"]} />
      <Note tone="info">{t("tailscaleGuide.scope")}</Note>
      <a href={DOCS} target="_blank" rel="noopener noreferrer" className="underline">{t("tailscaleGuide.docs")}</a>
    </section>
  );
}
