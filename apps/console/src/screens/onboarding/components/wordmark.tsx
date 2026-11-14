import { cn } from "@openedbot/browser-ui-kit";

/**
 * The mark, where Multica places its `MulticaIcon`: the application icon,
 * the same as the « Se connecter » step's (`screens/auth/login.tsx`) and the
 * old welcome shell's. Decorative: the word beside it carries the name.
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
