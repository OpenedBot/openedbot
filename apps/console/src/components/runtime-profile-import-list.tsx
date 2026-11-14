import type { RuntimeHostProfileDto } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";

export function RuntimeProfileImportList({
  profiles,
  selected,
  onToggle,
}: {
  profiles: RuntimeHostProfileDto[];
  selected: ReadonlySet<string>;
  onToggle: (slug: string) => void;
}) {
  const { t } = useT();
  if (profiles.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t("profileImport.empty")}</p>;
  }
  return (
    <ul className="overflow-hidden rounded-[20px] bg-[var(--openedbot-grouped-card)]">
      {profiles.map((profile) => {
        const disabled = profile.alreadyImported;
        const checked = disabled || selected.has(profile.name);
        const mission = profile.description?.trim() || t("profileImport.missionMissing");
        const model = profile.model.default ?? t("profileImport.modelUnknown");
        return (
          <li key={profile.name} className="border-b border-[var(--openedbot-grouped-separator)] last:border-b-0">
            <div
              className={cn(
                "openedbot-press relative flex min-h-12 w-full items-start gap-3 px-4 py-3 text-left",
                disabled && "opacity-60",
              )}
            >
              <input
                id={`profile-import-${profile.name}`}
                type="checkbox"
                className="mt-1 size-4 shrink-0"
                checked={checked}
                disabled={disabled}
                onChange={() => onToggle(profile.name)}
                aria-label={profile.displayName}
              />
              <span className="min-w-0 flex-1">
                <label htmlFor={`profile-import-${profile.name}`} className="block cursor-pointer">
                  <span className="block truncate text-[17px] leading-[22px]">{profile.displayName}</span>
                  <span className="mt-0.5 block text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">{mission}</span>
                  <span className="mt-1 block text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
                    {t("profileImport.model", { model })}
                    {" · "}
                    {t("profileImport.routines", { count: String(profile.routineCount) })}
                    {disabled ? ` · ${t("profileImport.already")}` : null}
                    {profile.hidden ? ` · ${t("profileImport.hidden")}` : null}
                  </span>
                </label>
                {profile.routines.length > 0 ? (
                  <details className="mt-2 text-[13px] leading-4">
                    <summary className="cursor-pointer text-[var(--openedbot-grouped-caption)]">
                      {t("profileImport.routineDetails")}
                    </summary>
                    <ul className="mt-1 space-y-1 pl-4 text-[var(--openedbot-grouped-caption)]">
                      {profile.routines.map((routine) => (
                        <li key={`${routine.name}:${routine.schedule}`}>
                          <span className="font-medium">{routine.name}</span>
                          <span className="block font-mono text-[12px]">{t("profileImport.routineSchedule", { schedule: routine.schedule })}</span>
                          <span className="block">{t("profileImport.routinePrompt", { prompt: routine.prompt })}</span>
                          {!routine.enabled ? ` · ${t("profileImport.routinePaused")}` : null}
                          {!routine.deliver ? ` · ${t("profileImport.routineNoDelivery")}` : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
