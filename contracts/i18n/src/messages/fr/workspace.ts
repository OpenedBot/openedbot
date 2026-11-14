/** French strings, one file per domain: `messages.fr.ts` assembles them. */

export const sectionCards = {
  title: "Indicateurs",
  description: "L’organisation en un coup d’œil, relue toutes les 15 secondes.",
  botsLabel: "Bots",
  conversationsBadge: "conversations",
  botsFooterTitle: "Un fil et une mémoire par bot",
  botsFooterSubtitle: "Chacun garde son modèle",
  runsLabel: "Exécutions",
  runsRunningBadge: "{count} en cours",
  runsFooterTitle: "{completed} terminées · {failed} en échec",
  runsFooterSubtitle: "Depuis le premier lancement",
  pendingLabel: "Décisions en attente",
  pendingBadgeYes: "à trancher",
  pendingBadgeNo: "rien à faire",
  pendingFooterTitleYes: "Un bot attend votre accord",
  pendingFooterTitleNo: "Aucune action bloquée",
  pendingFooterSubtitle: "Aucune action risquée sans décision",
  successRateLabel: "Taux de réussite",
  successRateEmpty: ":",
  successRateValue: "{rate} %",
  tokensBadge: "{count} jetons",
  successRateFooterTitleYes: "Aucune exécution achevée",
  successRateFooterTitleNo: "Sur les runs achevés",
  successRateFooterSubtitle: "Les annulations ne comptent pas",
} as const;

export const dashboardMetrics = {
  unavailable: "Ces chiffres ne sont pas disponibles pour le moment.",
  stale: "Ces valeurs sont périmées. Dernière réponse API : {date}.",
} as const;

export const chartArea = {
  title: "Activité des bots",
  descriptionFull: "Exécutions terminées et en échec, par jour",
  descriptionShort: "Exécutions par jour",
  range90d: "3 derniers mois",
  range30d: "30 derniers jours",
  range7d: "7 derniers jours",
  periodAriaLabel: "Choisir la période",
  emptyTitle: "Aucune exécution sur la période.",
  emptySubtitle: "Le graphique se remplira dès le premier message.",
  seriesCompleted: "Terminées",
  seriesFailed: "En échec",
} as const;

export const chartTokens = {
  title: "Consommation de jetons",
  descriptionFull: "Jetons consommés par les exécutions, par période",
  descriptionShort: "Jetons consommés",
  totalForPeriod: "{count} jetons sur la période affichée",
  granularityAriaLabel: "Choisir la granularité",
  granularityDay: "Par jour",
  granularityWeek: "Par semaine",
  granularityMonth: "Par mois",
  granularityYear: "Par année",
  weekOf: "Semaine du {date}",
  emptyTitle: "Aucune consommation sur la période.",
  emptySubtitle: "Les jetons apparaîtront dès la première exécution.",
  seriesInput: "Jetons d’entrée",
  seriesOutput: "Jetons de sortie",
} as const;
