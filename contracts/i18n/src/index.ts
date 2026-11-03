/**
 * Socle i18n: pur TypeScript, sans dépendance, importable par le web
 * (React/Vite) et le mobile (Expo/React Native) sans jamais charger
 * `react-native` : c'est la seule contrainte dure de L7, `bun test` ne sait
 * pas transpiler son point d'entrée Flow.
 *
 * Pas d'ICU ici: une interpolation `{nom}` et un pluriel à deux formes
 * suffisent à la taille du produit. `i18next` ou équivalent serait une
 * dépendance de plus pour un besoin que ce fichier couvre en une centaine de
 * lignes.
 */
import { DEFAULT_LOCALE, FALLBACK_LOCALE, type Locale } from "@openedbot/contracts-locale";
import { en } from "./messages.en";
import { fr } from "./messages.fr";

// La locale (type, défaut, repli, détection) est un contrat : ses appelants
// l'importent de `@openedbot/contracts-locale`, ce socle ne la réexporte pas.

const DICTIONARIES: Record<Locale, MessageTree> = { fr, en };

/** Arbre de messages : chaîne en feuille, espace de noms en nœud. */
export type MessageTree = { readonly [key: string]: string | MessageTree };

/** Toutes les clés en chemin pointé, calculées depuis le dictionnaire FR. */
export type MessagePaths<T, Prefix extends string = ""> = T extends string
  ? Prefix
  : {
      [K in keyof T & string]: MessagePaths<T[K], `${Prefix}${Prefix extends "" ? "" : "."}${K}`>;
    }[keyof T & string];

/**
 * The core console's keys. A console module types and registers its own
 * strings (`defineMessages`, `@openedbot/browser-i18n`), so none is here.
 */
export type MessageKey = MessagePaths<typeof fr>;

function getByPath(tree: MessageTree, path: string): string | undefined {
  let cur: string | MessageTree | undefined = tree;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === undefined) return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Traduit une clé. Une clé absente dans la locale active retombe sur le
 * français (repli exigé par US-I18N-01) puis, en dernier recours, rend la clé
 * elle-même plutôt que de jeter: un écran ne doit jamais planter pour une
 * chaîne manquante.
 */
export function t(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template =
    getByPath(DICTIONARIES[locale], key) ?? getByPath(DICTIONARIES[FALLBACK_LOCALE], key) ?? key;
  if (!params) return template;
  let out = template;
  for (const [name, value] of Object.entries(params)) {
    out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}

/**
 * Une clé est-elle réellement portée par un dictionnaire ?
 *
 * `t()` rend la clé elle-même quand elle manque, ce qui est le bon repli pour
 * un libellé statique mais pas pour une clé construite à l'exécution depuis un
 * code d'erreur de l'API : l'écran afficherait `login.failed.XXX` à
 * l'utilisateur. Un appelant qui fabrique sa clé teste ici et choisit son
 * propre message générique.
 */
export function hasMessage(key: string): boolean {
  return (
    getByPath(DICTIONARIES[FALLBACK_LOCALE], key) !== undefined ||
    getByPath(DICTIONARIES[DEFAULT_LOCALE], key) !== undefined
  );
}

// `plural`, `formatDate` et `formatNumber` ne servent qu'aux écrans : ils
// vivent dans `@openedbot/browser-i18n` (browser/i18n/src/format.ts).

export { en, fr };
