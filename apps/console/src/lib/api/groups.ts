import type { CreateGroupInput, GroupDto, SectionDto, SectionOrderInput, SectionsOrderInput, UpdateGroupInput } from "@openedbot/contracts-api";
import { request } from "./http";

export const groupsApi = {
  /**
   * Groups (bot mode « Groups »): the roster (`api.roster`) already carries
   * `groups`, activity-ordered like the bots: these routes serve
   * creation/editing, not the current list.
   */
  groups: () => request<{ groups: GroupDto[] }>("/api/groups"),
  group: (groupId: string) => request<GroupDto>(`/api/groups/${groupId}`),
  createGroup: (input: CreateGroupInput) =>
    request<GroupDto>("/api/groups", { method: "POST", body: JSON.stringify(input) }),
  updateGroup: (groupId: string, input: UpdateGroupInput) =>
    request<GroupDto>(`/api/groups/${groupId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteGroup: (groupId: string) => request<void>(`/api/groups/${groupId}`, { method: "DELETE" }),
  /** Cuts the room's in-flight send: the equivalent of `cancelRun` for a group turn. */
  stopRoom: (threadId: string) => request<void>(`/api/threads/${threadId}/stop`, { method: "POST" }),
  createSection: (name: string) =>
    request<SectionDto>("/api/sections", { method: "POST", body: JSON.stringify({ name }) }),
  updateSection: (sectionId: string, input: Partial<SectionDto>) =>
    request<SectionDto>(`/api/sections/${sectionId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteSection: (sectionId: string) =>
    request<void>(`/api/sections/${sectionId}`, { method: "DELETE" }),
  /** A section's full order; each cited row is placed at its index. */
  orderSection: (sectionId: string, input: SectionOrderInput) =>
    request<void>(`/api/sections/${sectionId}/order`, { method: "PUT", body: JSON.stringify(input) }),
  /** The pinned grid's order; each cited row is pinned at its index. */
  orderPins: (input: SectionOrderInput) =>
    request<void>("/api/sections/pinned/order", { method: "PUT", body: JSON.stringify(input) }),
  /** The order of the editable sections, top to bottom (« Non assigné » stays put). */
  orderSections: (input: SectionsOrderInput) =>
    request<void>("/api/sections/order", { method: "PUT", body: JSON.stringify(input) }),
};
