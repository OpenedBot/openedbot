import * as React from "react";

/**
 * Le libellé qui travaille, reflet animé en `transform` seul.
 *
 * `openedbot-agent-label` anime `background-position` d'un dégradé clippé au texte :
 * le navigateur repeint à chaque frame. Ici le texte de base est posé une fois
 * (teinte douce) et une bande, qui porte une COPIE du texte en teinte pleine,
 * traverse le libellé en `translate3d`; la copie reçoit la translation
 * inverse, donc ses glyphes restent exactement sur ceux de la base. Aucune
 * des deux animations ne touche la peinture (voir `.openedbot-shine` dans `app.css`).
 *
 * Pour un libellé sur UNE ligne (un parent `truncate` ou une ligne de
 * `RollText` le rogne). Un libellé qui passe à la ligne garde
 * `openedbot-agent-label` : la copie ne se replierait pas comme la base.
 */
export function ShineText({ children }: { children: string }) {
  return (
    <span className="openedbot-shine">
      {children}
      <span aria-hidden="true" className="openedbot-shine-band">
        <span className="openedbot-shine-text">{children}</span>
      </span>
    </span>
  );
}
