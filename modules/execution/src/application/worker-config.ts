import type { HermesClientTimeouts } from "@openedbot/hermes";
import type { EndpointPolicy } from "@openedbot/hermes/endpoint";
import type { HermesMtlsIdentity } from "@openedbot/hermes/mtls";
import type { SecretKeyring } from "@openedbot/hermes/secrets";

/**
 * La part de la configuration du worker que l'exécution lit. Le worker passe
 * sa `WorkerConfig` complète (`apps/worker/src/config.ts`), qui satisfait ce
 * type par structure : le module ne dépend pas de l'application.
 */
export type WorkerConfig = {
  workerId: string;
  apiInternalUrl: string;
  /** Dedicated connector gateway; omitted by legacy callers in monolithic mode. */
  runtimeLinkInternalUrl?: string;
  apiInternalToken: string;
  tokenEncryption: SecretKeyring;
  /** Process-wide outbound identity; certificate material is never persisted. */
  hermesMtls: HermesMtlsIdentity | null;
  /** Timeouts of the Hermes run and session calls; unset entries keep the client defaults. */
  hermesTimeouts?: Partial<HermesClientTimeouts>;
  /** Même politique d'endpoint que l'API : une seule construction, aucun oubli. */
  hermesEndpointPolicy: EndpointPolicy;
  leaseSeconds: number;
  /** Un run en streaming sans aucune frame depuis ce délai est avorté (retryable). */
  runInactivityMs: number;
  /** Durée maximale absolue d'un run, même si Hermes continue d'envoyer des frames. */
  runTimeoutMs: number;
  /** Fenêtre de polling GET après rupture SSE ou arrêt demandé. */
  reconciliationTimeoutMs: number;
  /** Applique le filtre d'abonnement à la réclamation des runs. false en phase de test. */
  billingEnforced: boolean;
  /** Part du prix plein imputée à un jeton d'entrée servi par le cache du fournisseur. */
  cachedInputTokenWeight: number;
  /** Origine de la PWA, pour les liens des e-mails transactionnels. */
  webAppUrl: string;
  /**
   * Magasin des pièces jointes, le même que l'API. Absent dans les tests du
   * runner qui ne posent pas de fichier : un tour sans `blob` n'attache rien.
   */
  blob?:
    | { driver: "file"; root: string }
    | { driver: "r2"; bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string };
};
