/** An organization's alert channel (`/api/alert-channels`, 0157). Discord first. */
export type AlertChannelKind = "discord";

/** Why the last send failed; `webhook_revoked` disabled the channel. */
export type AlertChannelFailureReason =
  | "webhook_revoked"
  | "rejected"
  | "rate_limited"
  | "unreachable"
  | "decryption_failed";

/** A channel as the console sees it: never the webhook URL, only its preview. */
export type AlertChannelDto = {
  id: string;
  kind: AlertChannelKind;
  label: string;
  /** `discord.com/api/webhooks/<id>/…`: the public identifier, without the token. */
  targetHint: string;
  enabled: boolean;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastFailureAt: string | null;
  lastFailureStatus: number | null;
  lastFailureReason: AlertChannelFailureReason | null;
};

export type AlertChannelListDto = { channels: AlertChannelDto[]; limit: number };

/** `POST /api/alert-channels`. Without `label`, the webhook's name on the Discord side. */
export type CreateAlertChannelInput = { kind: AlertChannelKind; webhookUrl: string; label?: string };

/** `PATCH /api/alert-channels/:id`. */
export type UpdateAlertChannelInput = { enabled?: boolean; label?: string };

/** `POST /api/alert-channels/:id/test`: the message went out; a failure is an HTTP error. */
export type AlertChannelTestDto = { delivered: true; channel: AlertChannelDto };
