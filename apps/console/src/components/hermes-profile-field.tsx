import { useQuery } from "@tanstack/react-query";
import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";

const ROOT = "__root__";

/**
 * `required` is the duplicate of a bot on a host without `profile_management`:
 * the copy needs its own profile, so the field drops its « leave it empty »
 * wording and `error` (the reason the value is refused) is announced under it.
 */
export function HermesProfileField({
  id,
  value,
  onChange,
  required = false,
  error = null,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  error?: string | null;
}) {
  const { t } = useT();
  const inventory = useQuery({
    queryKey: queryKeys.runtimeProfiles,
    queryFn: api.runtimeProfiles,
    retry: false,
  });
  const profiles = inventory.data?.profiles ?? null;
  const label = t(required ? "botCloneDialog.profileRequiredLabel" : "newBotDialog.profileLabel");
  const placeholder = required ? undefined : t("newBotDialog.profilePlaceholder");
  const errorId = `${id}-error`;
  const invalid = error ? { "aria-invalid": true as const, "aria-describedby": errorId } : {};
  const errorLine = error ? <p id={errorId} role="alert" className="text-sm text-destructive-text">{error}</p> : null;
  if (inventory.isPending) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input id={id} value={value} disabled placeholder={t("profileImport.loading")} />
        {errorLine}
      </div>
    );
  }
  if (inventory.isError || !profiles) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          {...invalid}
        />
        <p className="text-xs text-muted-foreground">{t(required ? "botCloneDialog.profileHint" : "newBotDialog.profileHint")}</p>
        {errorLine}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || ROOT} onValueChange={(next) => onChange(next === ROOT ? "" : next)}>
        <SelectTrigger id={id} {...invalid}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ROOT}>{t("profileImport.rootProfile")}</SelectItem>
          {profiles.map((profile) => (
            <SelectItem key={profile.name} value={profile.name} disabled={profile.alreadyImported}>
              {profile.displayName}
              {profile.alreadyImported ? ` (${t("profileImport.already")})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t("profileImport.selectorHint")}</p>
      {errorLine}
    </div>
  );
}
