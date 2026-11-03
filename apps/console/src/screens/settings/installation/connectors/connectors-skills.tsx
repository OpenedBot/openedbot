import { useState } from "react";
import { IconSparkles } from "@tabler/icons-react";
import type { BotSkillDto, RuntimeIntegrationInventoryDto } from "@openedbot/contracts-api";
import { useT, type MessageKey } from "../../../../lib/i18n";
import { Note } from "../../../../components/settings/primitives";
import { matchesQuery } from "./connectors-catalog-model";
import { SkillDialog, groupSkills } from "./connectors-parts";

/**
 * Les catégories que Hermes range dans `skills/<catégorie>/` : un slug de
 * dossier (« autonomous-ai-agents »), jamais un titre. Une catégorie inconnue
 * se lit par `humanizeCategory`.
 */
const SKILL_CATEGORY: Record<string, MessageKey> = {
  "autonomous-ai-agents": "connectorsPage.skillCategoryAgents",
  creative: "connectorsPage.skillCategoryCreative",
  "data-science": "connectorsPage.skillCategoryDataScience",
  devops: "connectorsPage.skillCategoryDevops",
  email: "connectorsPage.skillCategoryEmail",
  github: "connectorsPage.skillCategoryGithub",
  media: "connectorsPage.skillCategoryMedia",
  mlops: "connectorsPage.skillCategoryMlops",
  "note-taking": "connectorsPage.skillCategoryNotes",
  productivity: "connectorsPage.skillCategoryProductivity",
  research: "connectorsPage.skillCategoryResearch",
  "smart-home": "connectorsPage.skillCategorySmartHome",
  "social-media": "connectorsPage.skillCategorySocial",
  "software-development": "connectorsPage.skillCategorySoftware",
  web: "connectorsPage.skillCategoryWeb",
};

/** « red-teaming » → « Red teaming » : un slug inconnu reste lisible. */
export function humanizeCategory(category: string): string {
  const words = category.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Réglages › Connecteurs › Compétences, sur le modèle de la liste d'OpenBot :
 * pas de carte autour d'un groupe, un titre lisible suivi du nombre, un filet
 * entre les groupes ; des lignes sans séparateur sur deux colonnes, une tuile
 * de 36 px au même glyphe pour toutes (une skill Hermes n'a pas d'icône, et
 * une initiale répétée — « C, C, C » — se lit comme du bruit), le nom puis
 * une ligne de description, un fond au survol.
 */
export function SkillsTab({ data, query }: { data: RuntimeIntegrationInventoryDto; query: string }) {
  const { t } = useT();
  const [selected, setSelected] = useState<BotSkillDto | null>(null);
  if (data.skills === null) {
    return (
      <Note tone={data.skillsError ? "danger" : "neutral"}>
        {t(data.skillsError ? "connectorsSettings.skillsFailed" : "connectorsSettings.skillsUnavailable")}
      </Note>
    );
  }
  if (data.skills.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("connectorsSettings.skillsEmpty")}</p>;
  }
  const groups = groupSkills(data.skills.filter((skill) => matchesQuery(skill, query)));
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("connectorsPage.noMatch", { query: query.trim() })}</p>;
  }
  const label = (category: string) => {
    if (!category) return t("connectorsSettings.uncategorized");
    const key = SKILL_CATEGORY[category];
    return key ? t(key) : humanizeCategory(category);
  };
  return (
    <div className="space-y-5">
      {groups.map(([category, entries]) => {
        const id = `connectors-skills-${category || "uncategorized"}`;
        return (
          <section
            key={category || "uncategorized"}
            aria-labelledby={id}
            className="@container space-y-2 border-t border-border/60 pt-5 first:border-t-0 first:pt-0"
          >
            <h3 id={id} className="flex items-baseline gap-2 px-2 text-sm font-semibold tracking-tight text-foreground">
              {label(category)}
              <span className="font-normal tabular-nums text-muted-foreground">{entries.length}</span>
            </h3>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 @xl:grid-cols-2">
              {entries.map((skill) => (
                <li key={skill.name} data-skill-row="" className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setSelected(skill)}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl p-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      aria-hidden
                      className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-muted text-muted-foreground"
                    >
                      <IconSparkles className="size-[18px]" stroke={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{skill.name}</span>
                      {skill.description ? (
                        <span className="block truncate text-xs leading-5 text-muted-foreground">{skill.description}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <SkillDialog skill={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
