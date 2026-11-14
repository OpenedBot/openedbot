/**
 * Partitions a roster according to the personal visibility preference.
 *
 * `hidden` is optional so that a recent client stays compatible with an
 * older server. The absence of the field is therefore deliberately visible:
 * a thread must never disappear on unknown information.
 * Server order is preserved in both partitions.
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
 * Index / selector: the threads the operator has not hidden.
 * Same rule as `partitionThreadVisibility`: the HTTP roster also carries
 * the hidden ones; it is up to the client to remove them from the current lists.
 */
export function visibleRosterItems<T extends object>(items: readonly T[]): T[] {
  return partitionThreadVisibility(items).visible;
}
