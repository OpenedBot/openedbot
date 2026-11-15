import type { AlertChannelDto, AlertChannelListDto, AlertChannelTestDto, CreateAlertChannelInput, UpdateAlertChannelInput } from "@openedbot/contracts-api";
import { request } from "./http";

export const notificationsApi = {
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
