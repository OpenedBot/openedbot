# PWA design : Inset Grouped

Le nom du pattern : **iOS Inset Grouped** (`UITableView.Style.insetGrouped`).
C’est la feuille Réglages de ChatGPT iOS, pas la liste colorée de Réglages.app.

Toute surface PWA qui présente des rubriques (roue crantée d’un bot, `/settings`)
suit ce document. Le bureau (nav latérale, modal deux colonnes) n’en hérite pas.

## Sujet

Un opérateur règle **un bot Hermes** depuis l’iPhone, en standalone. Un seul
job : choisir une rubrique, puis l’éditer. Le visage du bot est le sujet, pas
l’opérateur, pas le SaaS.

## Tokens

| Rôle | Clair | Sombre |
| --- | --- | --- |
| Canvas (`--ohb-grouped-canvas`) | `#F2F2F7` | `#000000` |
| Carte (`--ohb-grouped-card`) | `#FFFFFF` | `#1C1C1E` |
| Filet inset (`--ohb-grouped-separator`) | `rgba(60,60,67,0.12)` | `rgba(84,84,88,0.65)` |
| Libellé / icône (`--ohb-grouped-label`) | `#000000` | `#F5F5F7` |
| Légende / valeur (`--ohb-grouped-caption`) | `#6D6D72` | `#8E8E93` |
| Chevron (`--ohb-grouped-chevron`) | `#C7C7CC` | `#636366` |
| Pastille fermer (`--ohb-grouped-close`) | `rgba(120,120,128,0.16)` | `rgba(120,120,128,0.24)` |
| Pressé (`--ohb-grouped-press`) | `rgba(0,0,0,0.04)` | `#2C2C2E` |
| Retour (`--ohb-grouped-back`) | `#007AFF` | `#0A84FF` |

Rayons : carte `20px`, feuille `32px` en haut seulement.
Type : `-apple-system, system-ui` déjà servi par le shell. Corps de ligne
`17/22`, légende de groupe `13/16` sentence case (jamais en capitales).
Icônes : outline Tabler, 22 px, trait 1.5, **monochrome**, pas de tuile teintée.

Variables dans `browser/ui-kit/src/styles/mobile.css`. Primitives dans
`src/components/mobile/inset-grouped.tsx`.

## Layout

```
┌─ feuille 32px ─────────────────┐
│                          (✕)   │
│            [visage]            │
│              Nom               │
│                                │
│  Personnaliser Nom             │
│  ┌─ carte 20px ─────────────┐  │
│  │ ⚙  Général         Nom  ›│  │
│  │    ──────────────────    │  │
│  │ ✎  Apparence            ›│  │
│  └──────────────────────────┘  │
└────────────────────────────────┘
```

- Feuille ancrée bas, quasi plein écran, canvas vrai noir (sombre).
- Fermer : pastille circulaire en haut à droite, pas un bouton ghost.
- Hero : `BotFace` 88 px centré, crayon en overlay → rubrique Apparence.
- Groupes : légende au-dessus, carte sans bordure (le contraste canvas/carte
  fait le relief). Filets **inset** : ils commencent sous le libellé, pas sous
  l’icône.
- Ligne : icône · libellé · valeur grise optionnelle · chevron. 48 pt min.
- Pile : tap → rubrique poussée (`‹ Retour` + titre centré + ✕). Enregistrer
  (et tout CTA de page) vit dans `MobileActionFooter` : barre iOS `.bottomBar`,
  dernier enfant de la colonne, **pas** `position: fixed`, pas une rangée
  `ACTIONS` dans le scroll. L’index n’a pas de CTA. Pilule 44 pt, libellé
  **centré** (`justify-center` + `text-center`) : `items-center` seul laisse
  « Enregistrer » à gauche une fois le bouton étiré.

## Retour

`‹ Retour` est un contrôle de barre de nav iOS, pas un bouton ghost.

- Chevron + libellé `17/22`, bleu système (`--ohb-grouped-back` : `#007AFF` /
  `#0A84FF`). Jamais `--primary` (violet console).
- Pas de fond, pas de bord, pas de pastille. Appuyé : opacity `0.55`.
- Cible 44 pt. Primitive : `InsetBackButton` / `insetBackClassName`.

## Toast

Bandeau iOS sous l’island, pas le snackbar bureau (bas-droite, carte bordée).

- Ancré `top-center`, `top: max(0.75rem, var(--ohb-safe-top))`, inset 16 px.
- Pleine largeur dans l’inset, rayon `20px`, matériau
  `#1C1C1E` / blur + saturate. Texte `#F5F5F7`, caption `#8E8E93`.
- Titre `17/22`, description `15/20`. Pas de filet, pas d’ombre bureau.
- L’API `toast.success` / `.error` ne change pas, seulement le chrome PWA.
- `prefers-reduced-motion` : pas de blur ni d’animation.

## Signature

Le visage vivant du bot en hero. C’est la seule pièce mémorable. Autour :
discipline iOS, zéro décor.

Risque assumé : on refuse les tuiles colorées d’iOS Settings et les filets
pleine largeur. ChatGPT iOS non plus : les icônes sont des traits blancs, les
cartes n’ont pas de stroke.

## Copie

Noms de ce que l’opérateur contrôle, pas de ce que le système construit.

- « Personnaliser {name} », « Intelligence », « Connexions »
- « Enregistrer » / « Enregistrement… » / « {name} enregistré. »
- Une erreur dit quoi a cassé. Un vide invite à agir.

## Do / Don’t

- Do : `env(safe-area-inset-*)`, cibles 44 pt, `ohb-press`, `prefers-reduced-motion`.
- Do : valeurs à droite quand elles existent (nom, modèle, `@slug`).
- Don’t : tuile d’icône teintée, filet au-dessus du composer, uppercase de groupe.
- Don’t : nav latérale, carte bordée, modal centrée : sur `pointer: coarse`.
- Don’t : inventer un second language visuel pour une autre feuille PWA.
  Étendre ces primitives.

## Lancement

La console est une webapp classique (plus de manifeste, de service worker ni
de splash iOS depuis le 2026-10-27). `index.html` peint seulement l’encre de
fond (`#121212`, ou blanc en thème clair) et `#root` reste visible dès le
premier paint. Le premier écran est celui de la route, sans animation
intermédiaire.

## Bureau

Inchangé : modal deux colonnes, nav à gauche. Ce document ne s’applique qu’à
`useIsMobile()` / `[data-mobile-shell]`.
