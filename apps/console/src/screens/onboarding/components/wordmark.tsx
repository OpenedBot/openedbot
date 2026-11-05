import { cn } from "@openedbot/browser-ui-kit";

/**
 * La marque, là où Multica pose son `MulticaIcon` : l'icône de l'application,
 * la même que celle de l'étape « Se connecter » (`screens/auth/login.tsx`) et de
 * l'ancienne coque d'accueil. Décorative : le mot à côté porte le nom.
 *
 * The transparent mark blends into both light and dark page backgrounds.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/openedbot-icon.webp"
      alt=""
      aria-hidden="true"
      className={cn("object-contain", className)}
    />
  );
}
