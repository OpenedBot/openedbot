declare module "web-push" {
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options?: { TTL?: number; urgency?: string; timeout?: number },
  ): Promise<{ statusCode: number }>;
}
