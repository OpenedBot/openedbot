/**
 * Le ticket d'appairage d'un runtime, ouvert depuis l'application.
 *
 * Il ne porte aucun bearer : c'est le script qui va lire celui du gateway sur
 * l'hôte, puis le pousser. `scriptSha256` est l'empreinte du script réellement
 * servi par cette API, pour que l'opérateur puisse la comparer avant de
 * l'exécuter.
 */
export type RuntimeEnrollmentTicketDto = {
  enrollmentId: string;
  reachability: "connector";
  /** Toujours `null` : aucune URL du gateway n'existe côté cloud. */
  endpoint: null;
  runtimeName: string;
  /** `<enrollmentId>.<secret>`, à usage unique et périmé avec `expiresAt`. */
  ticket: string;
  /** Le ticket est saisi à l'invite masquée, jamais placé en argv. */
  command: string;
  expiresAt: string;
};

/** L'état d'un enrôlement ouvert ici ; c'est lui que l'écran sonde en attendant l'hôte. */
export type RuntimeEnrollmentStatusDto = {
  enrollmentId: string;
  reachability: "connector";
  state: "pending" | "claimed" | "completed" | "expired";
  runtimeId: string | null;
  expiresAt: string;
};
