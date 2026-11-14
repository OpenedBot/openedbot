export type PushVapidPublicKeyDto = { publicKey: string; configured: true };

export type PushSubscriptionDto = {
  id: string;
  endpoint: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type PushSubscriptionListDto = { subscriptions: PushSubscriptionDto[]; configured: boolean };

export type CreatePushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale?: string;
};

/** `GET /api/push/apns/config`: `false` when the deployment has no APNs key. */
export type ApnsConfigDto = { enabled: boolean };

/** `PUT /api/push/apns/devices/:installationId` body. `token` is the APNs device token in hex. */
export type RegisterApnsDeviceInput = {
  token: string;
  bundleId: string;
  environment: "sandbox" | "production";
};

/** `PUT /api/push/apns/devices/:installationId` answer; the token is never echoed. */
export type ApnsDeviceRegistrationDto = {
  installationId: string;
  enabled: true;
  lastRegisteredAt: string;
};

/**
 * `GET /api/push/apns/devices/:installationId`. `enabled: false` once the
 * server revoked the registration (token moved to another account, or Apple
 * answered Unregistered / BadDeviceToken): the client registers again.
 */
export type ApnsDeviceDto = { enabled: boolean; lastRegisteredAt: string };
