/**
 * Partitionne un roster selon la préférence personnelle de visibilité.
 *
 * `hidden` est optionnel pour qu'un client récent reste compatible avec un
 * serveur plus ancien. L'absence du champ est donc volontairement visible :
 * on ne doit jamais faire disparaître un fil sur une information inconnue.
 * L'ordre serveur est préservé dans les deux partitions.
 */
export function partitionThreadVisibility<T extends object>(items: readonly T[]): {
  visible: T[];
  hidden: T[];
} {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const item of items) {
    ((item as { hidden?: boolean }).hidden === true ? hidden : visible).push(item);
  }
  return { visible, hidden };
}

/**
 * Index / sélecteur : les fils que l'opérateur n'a pas masqués.
 * Même règle que `partitionThreadVisibility` : le roster HTTP porte aussi
 * les masqués ; c'est au client de les retirer des listes courantes.
 */
export function visibleRosterItems<T extends object>(items: readonly T[]): T[] {
  return partitionThreadVisibility(items).visible;
}
