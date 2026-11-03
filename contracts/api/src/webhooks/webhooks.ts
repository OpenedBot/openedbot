import type { WorkflowStatus } from "../execution/runs";

export type WebhookEndpointDto = {
  id: string;
  threadId: string;
  target: "dm" | "group";
  name: string;
  instructions: string;
  enabled: boolean;
  deliveryCount: number;
  lastReceivedAt: string | null;
  rotatedAt: string;
  deletedAt: string | null;
  createdAt: string;
  /** Relative on purpose: the bearer secret never belongs in a URL. */
  ingressPath: string;
};

export type WebhookDeliveryReceiptDto = {
  id: string;
  endpointId: string;
  idempotencyKey: string;
  eventName: string | null;
  runId: string | null;
  workflowId: string | null;
  workflowStatus: WorkflowStatus | null;
  errorCode: string | null;
  receivedAt: string;
  acceptedAt: string | null;
};

export type WebhookEndpointListDto = {
  endpoints: WebhookEndpointDto[];
  receipts: WebhookDeliveryReceiptDto[];
};

export type CreateWebhookEndpointInput = {
  threadId: string;
  name: string;
  instructions: string;
};

export type UpdateWebhookEndpointInput = Partial<Pick<CreateWebhookEndpointInput, "name" | "instructions"> & {
  enabled: boolean;
}>;

/** Returned only by create/rotate; list and receipts never contain it. */
export type WebhookCredentialDto = {
  ingressPath: string;
  secret: string;
};

export type WebhookEndpointCreatedDto = {
  endpoint: WebhookEndpointDto;
  credential: WebhookCredentialDto;
};

export type WebhookIngressAcceptedDto = {
  accepted: true;
  duplicate: boolean;
  receiptId: string;
  runId: string;
  workflowId: string;
};
