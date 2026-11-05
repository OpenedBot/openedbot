import { useEffect, useState } from "react";

/**
 * L'état « la carte du guichet est ouverte », au niveau module.
 *
 * Seule la BULLE s'en sert : page publique, connexion, légal, onboarding.
 * Dans l'application, le guichet est une page (`/support`), et c'est l'URL
 * qui dit s'il est à l'écran.
 */

let open = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function openSupportPanel(): void {
  if (open) return;
  open = true;
  notify();
}

export function closeSupportPanel(): void {
  if (!open) return;
  open = false;
  notify();
}

export function isSupportPanelOpen(): boolean {
  return open;
}

export function useSupportPanelOpen(): boolean {
  const [value, setValue] = useState(open);
  useEffect(() => {
    const listener = () => setValue(open);
    listeners.add(listener);
    // Une ouverture survenue entre le premier rendu et l'abonnement serait
    // sinon perdue.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}
