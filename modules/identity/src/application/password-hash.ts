/**
 * Vérifie un mot de passe tel que saisi. Jusqu'au correctif des espaces de
 * bord (2026-11), la connexion et le changement de mot de passe rognaient la
 * saisie : un hachage écrit par ce changement ne correspond qu'à la forme
 * rognée. Elle n'est essayée qu'en second, et seulement si elle diffère :
 * l'ensemble accepté reste celui d'avant, plus la saisie exacte.
 */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (await Bun.password.verify(password, passwordHash)) return true;
  const trimmed = password.trim();
  return trimmed !== password && trimmed.length > 0 && Bun.password.verify(trimmed, passwordHash);
}
