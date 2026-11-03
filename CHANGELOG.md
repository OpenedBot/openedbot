# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce journal couvre l'application openedbot (console, API, worker). Le
connecteur hôte et le protocole tiennent le leur :
[`edge-setup/CHANGELOG.md`](edge-setup/CHANGELOG.md) et
[`protocol/CHANGELOG.md`](protocol/CHANGELOG.md).

## Non publié

### Ajouté

- **Planifier d'abord.** Le menu « + » du composer propose de demander un plan
  avant d'agir, pour les messages de cette conversation seulement. Le bot
  propose un plan sans rien modifier ; « Lancer » l'exécute ensuite avec ses
  règles habituelles. Ses autres conversations et ses routines ne changent pas.
- Un indicateur dans l'en-tête d'une conversation signale un bot en Mode plan
  ou en Accès complet, y compris quand l'organisation en réduit l'effet. Un
  clic ouvre ses règles d'approbation.
- Réglages › Apparence › Accent : dans la conversation d'un bot, les boutons
  et le focus prennent la couleur du bot, ou gardent l'accent de l'application.
- Le menu du compte affiche le quota fournisseur le plus entamé.
- Les résultats de recherche disent qui a écrit, à qui, et quand.

### Modifié

- Le mode de permission d'un bot se règle dans sa fiche (Règles
  d'approbation) et plus depuis le composer : c'est une règle du bot, valable
  pour toutes ses conversations et ses routines.
- Nouveau thème des conversations, en clair comme en sombre :
  - bulles, groupement des messages, blocs de code avec bouton de copie et
    couleurs de syntaxe revues ;
  - largeur de lecture alignée avec le composer ;
  - animations d'arrivée des messages et d'ouverture du composer.
- Les actions d'un message (copier, citer, réagir…) passent dans un menu
  contextuel : clic droit, ou appui long sur téléphone.
- Barre latérale : lignes de conversation plus grandes, en-têtes de section
  revus.
- Taille de texte par défaut : 14 px.
- Sans choix explicite, le modèle proposé d'office est celui de la gamme
  courante d'une famille (Sonnet, Luna, Flash), jamais son haut de gamme.

### Retiré

- Le compte agence de démonstration du jeu de données de développement.
