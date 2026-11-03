import { useEffect, useState } from "react";

/**
 * Un compte à rebours vers une échéance donnée par le SERVEUR (`expiresAt`) :
 * l'écran ne mesure jamais une durée à partir de son propre clic, il relit
 * l'heure murale à chaque seconde contre l'échéance publiée. Une horloge qui
 * dérive, un onglet endormi puis réveillé : le chiffre affiché se recale au
 * battement suivant, il ne s'accumule pas.
 *
 * `ratio` est la part restante depuis le montage : la jauge d'un ticket qui
 * vient d'être créé part pleine sans que l'API ait à publier sa durée.
 */
export function useCountdown(expiresAt: string): { remainingMs: number; ratio: number } {
  const endsAt = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  const [startedAt] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  // Une échéance illisible vaut « échue » : jamais un compte à rebours infini.
  const remainingMs = Number.isFinite(endsAt) ? Math.max(0, endsAt - now) : 0;
  const totalMs = Math.max(1, endsAt - startedAt);
  return { remainingMs, ratio: Number.isFinite(totalMs) ? Math.min(1, remainingMs / totalMs) : 0 };
}

/** `MM:SS` sous l'heure (un ticket), `H:MM:SS` au-delà (un bail de quelques heures). */
export function formatCountdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${String(minutes).padStart(2, "0")}:${rest}`;
}
