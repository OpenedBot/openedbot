/** Canal d'alerte d'une organisation (`/api/alert-channels`, 0157). Discord d'abord. */
export type AlertChannelKind = "discord";

/** Pourquoi le dernier envoi a échoué ; `webhook_revoked` a désactivé le canal. */
export type AlertChannelFailureReason =
  | "webhook_revoked"
  | "rejected"
  | "rate_limited"
  | "unreachable"
  | "decryption_failed";

/** Un canal tel que la console le voit : jamais l'URL du webhook, seulement son aperçu. */
export type AlertChannelDto = {
  id: string;
  kind: AlertChannelKind;
  label: string;
  /** `discord.com/api/webhooks/<id>/…` : l'identifiant public, sans le jeton. */
  targetHint: string;
  enabled: boolean;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastFailureAt: string | null;
  lastFailureStatus: number | null;
  lastFailureReason: AlertChannelFailureReason | null;
};

export type AlertChannelListDto = { channels: AlertChannelDto[]; limit: number };

/** `POST /api/alert-channels`. Sans `label`, le nom du webhook côté Discord. */
export type CreateAlertChannelInput = { kind: AlertChannelKind; webhookUrl: string; label?: string };

/** `PATCH /api/alert-channels/:id`. */
export type UpdateAlertChannelInput = { enabled?: boolean; label?: string };

/** `POST /api/alert-channels/:id/test` : le message est parti ; un échec est une erreur HTTP. */
export type AlertChannelTestDto = { delivered: true; channel: AlertChannelDto };
