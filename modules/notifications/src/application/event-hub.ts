import type { OrganizationEvent } from "@openedbot/contracts-events";

type Listener = (event: OrganizationEvent) => void;

export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(event: OrganizationEvent): void {
    for (const listener of this.listeners.get(event.organizationId) ?? []) listener(event);
  }

  subscribe(organizationId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(organizationId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(organizationId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(organizationId);
    };
  }

  subscriberCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}
