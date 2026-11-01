import type { CreateGroupInput, GroupDto, SectionDto, SectionOrderInput, UpdateGroupInput } from "@openedbot/contracts-api";
import { request } from "./http";

export const groupsApi = {
  /**
   * Groupes (bot mode « Groups »): le roster (`api.roster`) porte déjà
   * `groups`, activity-ordered comme les bots : ces routes servent la
   * création/édition, pas la liste courante.
   */
  groups: () => request<{ groups: GroupDto[] }>("/api/groups"),
  group: (groupId: string) => request<GroupDto>(`/api/groups/${groupId}`),
  createGroup: (input: CreateGroupInput) =>
    request<GroupDto>("/api/groups", { method: "POST", body: JSON.stringify(input) }),
  updateGroup: (groupId: string, input: UpdateGroupInput) =>
    request<GroupDto>(`/api/groups/${groupId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteGroup: (groupId: string) => request<void>(`/api/groups/${groupId}`, { method: "DELETE" }),
  /** Coupe l'envoi en cours du salon: l'équivalent de `cancelRun` pour un tour de groupe. */
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
  /** L'ordre complet d'une section ; chaque ligne citée y est rangée à son index. */
  orderSection: (sectionId: string, input: SectionOrderInput) =>
    request<void>(`/api/sections/${sectionId}/order`, { method: "PUT", body: JSON.stringify(input) }),
};
