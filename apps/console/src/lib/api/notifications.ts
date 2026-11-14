import type { AlertChannelDto, AlertChannelListDto, AlertChannelTestDto, CreateAlertChannelInput, CreatePushSubscriptionInput, PushSubscriptionListDto, PushVapidPublicKeyDto, UpdateAlertChannelInput } from "@openedbot/contracts-api";
import { request } from "./http";

export const notificationsApi = {
  // TODO(notifications): no longer used by the console since the PWA SW was removed;
  // to be picked up by the desktop app notifications / APNs.
  pushVapidPublicKey: () => request<PushVapidPublicKeyDto>("/api/push-subscriptions/vapid-public-key"),
  pushSubscriptions: () => request<PushSubscriptionListDto>("/api/push-subscriptions"),
  createPushSubscription: (input: CreatePushSubscriptionInput) =>
    request<unknown>("/api/push-subscriptions", { method: "POST", body: JSON.stringify(input) }),
  deletePushSubscription: (endpoint: string) =>
    request<void>("/api/push-subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) }),
  /** The space's alert channels (Discord): owner and admin only. */
  alertChannels: () => request<AlertChannelListDto>("/api/alert-channels"),
  createAlertChannel: (input: CreateAlertChannelInput) =>
    request<AlertChannelDto>("/api/alert-channels", { method: "POST", body: JSON.stringify(input) }),
  updateAlertChannel: (id: string, input: UpdateAlertChannelInput) =>
    request<AlertChannelDto>(`/api/alert-channels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAlertChannel: (id: string) =>
    request<void>(`/api/alert-channels/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testAlertChannel: (id: string) =>
    request<AlertChannelTestDto>(`/api/alert-channels/${encodeURIComponent(id)}/test`, { method: "POST" }),
};
