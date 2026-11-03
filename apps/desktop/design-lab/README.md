# openedbot design lab

Atelier pour itérer sur les templates de la page de connexion de l'app desktop
et choisir le bon. Il affiche la **vraie** page (`../src/renderer/signin.html`,
`signin-base.css`, `templates/*.css`, `assets/`) dans des iframes : ce que le
lab montre est ce que l'app livre.

```sh
make lab            # depuis ohb-desktop : bun install + Vite sur http://localhost:5317
```

- **Galerie** (`/`) : tous les templates en direct, mêmes réglages pour tous :
  thème (sombre, clair, les deux), langue (FR, EN), état (repos, déconnecté,
  session expirée, chargement, attente Google, connexion en cours, erreur,
  Google indisponible, API muette, comptes de dev) et taille de fenêtre
  (de 800 × 560 à 1700 × 1050). Une pastille par aperçu résume les contrôles
  de mise en page. Favoris (★) pour la short-list, cases « Comparer ».
- **Fiche** (`/t/<template>`) : grand aperçu interactif, sombre et clair côte à
  côte, contrôles détaillés, flèches ← → pour passer d'un template à l'autre,
  bouton **Utiliser dans l'app** (écrit `signinTemplate` dans
  `~/Library/Application Support/openedbot/config.json` ; relancer l'app).
- **Comparaison** (`/compare?names=a,b,c`) : 2 à 4 templates côte à côte.

Les réglages vivent dans l'URL : une vue du lab est un lien.

Modifier un fichier de `../src/renderer/` met à jour les aperçus sans recharger
le lab (feuille de style seule pour un template, page entière pour le reste).
Un nouveau template (`../src/renderer/templates/<nom>.css`, voir le
`README.md` de ce dossier) apparaît tout seul.

Les contrôles de mise en page sont ceux de `/tmp/ohb-e2e/gallery.ts` : template
appliqué, « Se connecter » et les sélecteurs langue / thème visibles sans
défiler, pas de défilement horizontal, aucun chevauchement entre le titre, le
texte, les boutons et les champs.
