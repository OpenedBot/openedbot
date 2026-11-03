import type { CreateWebhookEndpointInput, UpdateWebhookEndpointInput, WebhookEndpointCreatedDto, WebhookEndpointDto, WebhookEndpointListDto } from "@openedbot/contracts-api";
import { request } from "./http";

/** Une propriété secrète inattendue ne doit jamais survivre dans QueryClient. */
export function sanitizeWebhookList(value: WebhookEndpointListDto): WebhookEndpointListDto {
  return {
    endpoints: value.endpoints.map((endpoint) => ({
      id: endpoint.id,
      threadId: endpoint.threadId,
      target: endpoint.target,
      name: endpoint.name,
      instructions: endpoint.instructions,
      enabled: endpoint.enabled,
      deliveryCount: endpoint.deliveryCount,
      lastReceivedAt: endpoint.lastReceivedAt,
      rotatedAt: endpoint.rotatedAt,
      deletedAt: endpoint.deletedAt,
      createdAt: endpoint.createdAt,
      ingressPath: endpoint.ingressPath,
    })),
    receipts: value.receipts.map((receipt) => ({
      id: receipt.id,
      endpointId: receipt.endpointId,
      idempotencyKey: receipt.idempotencyKey,
      eventName: receipt.eventName,
      runId: receipt.runId,
      workflowId: receipt.workflowId,
      workflowStatus: receipt.workflowStatus,
      errorCode: receipt.errorCode,
      receivedAt: receipt.receivedAt,
      acceptedAt: receipt.acceptedAt,
    })),
  };
}

export const webhooksApi = {
  webhooks: async (threadId: string) =>
    sanitizeWebhookList(await request<WebhookEndpointListDto>(`/api/webhooks?threadId=${encodeURIComponent(threadId)}`)),
  createWebhook: (input: CreateWebhookEndpointInput, idempotencyKey: string) =>
    request<WebhookEndpointCreatedDto>("/api/webhooks", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  updateWebhook: (endpointId: string, input: UpdateWebhookEndpointInput) =>
    request<WebhookEndpointDto>(`/api/webhooks/${endpointId}`, { method: "PATCH", body: JSON.stringify(input) }),
  rotateWebhook: (endpointId: string, idempotencyKey: string) =>
    request<WebhookEndpointCreatedDto>(`/api/webhooks/${endpointId}/rotate`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  deleteWebhook: (endpointId: string) =>
    request<void>(`/api/webhooks/${endpointId}`, { method: "DELETE" }),
};
