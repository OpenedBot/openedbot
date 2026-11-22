import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../../../lib/i18n";
import { AccountClosureSection } from "../../settings/account/closure";

/** Loaded only on demand. Needs no workspace or its route guard. */
export default function OnboardingAccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  return (
    <Dialog open onClose={onClose} title={t("settingsAccount.closureTitle")} closeLabel={t("common.close")} className="max-w-lg">
      <AccountClosureSection bare />
    </Dialog>
  );
}
