type SubscriptionDto = {
  status: string;
  currentPeriodEnd: string | null;
  runtimeLimit: number;
  memberLimit: number;
  concurrentRunLimit: number;
  attachmentQuotaBytes: number;
  updatedAt: string | null;
};

type BillingPlanDto = {
  amountEur: number;
  currency: "EUR";
  interval: "month";
  runtimeLimit: number;
  memberLimit: number;
  concurrentRunLimit: number;
  attachmentQuotaBytes: number;
};

/**
 * Ce que l'organisation occupe aujourd'hui, en regard des plafonds du plan.
 * Compté à la lecture, avec exactement les filtres des gardes qui refusent :
 * membres et invitations encore ouvertes comme `member-routes`, runs en vol
 * comme la file du worker, octets de pièces jointes non supprimées comme
 * l'ingress. Sans ces compteurs, l'écran ne sait dire qu'un plafond, jamais
 * s'il reste de la marge.
 */
export type BillingUsageDto = {
  runtimes: number;
  members: number;
  concurrentRuns: number;
  attachmentBytes: number;
};

export type BillingDto = {
  subscription: SubscriptionDto | null;
  plan: BillingPlanDto;
  usage: BillingUsageDto;
  /** `false` tant que le déploiement n'a pas les clés du fournisseur de paiement : l'écran l'explique au lieu d'un bouton mort. */
  configured: boolean;
  /** `false` en phase de test : l'accès ne dépend pas du paiement, l'UI masque le paywall. */
  enforced: boolean;
};
