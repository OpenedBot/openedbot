import { Dialog, Tabs, TabsContent, TabsList, TabsTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../../../lib/i18n";
import { AccountClosureSection } from "../../settings/account/closure";
import { CloudSecuritySettings } from "../../settings/journal/security";

/** Loaded only on demand. Neither pane needs a workspace or its route guard. */
export default function OnboardingAccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  return (
    <Dialog open onClose={onClose} title={t("settingsAccount.title")} closeLabel={t("common.close")} className="max-w-3xl">
      <Tabs defaultValue="closure" className="min-h-0 gap-4">
        <TabsList>
          <TabsTrigger value="closure">{t("settingsAccount.closureTitle")}</TabsTrigger>
          <TabsTrigger value="sessions">{t("settingsSecurity.tabDevices")}</TabsTrigger>
        </TabsList>
        <TabsContent value="closure"><AccountClosureSection /></TabsContent>
        <TabsContent value="sessions"><CloudSecuritySettings sessionsOnly /></TabsContent>
      </Tabs>
    </Dialog>
  );
}
