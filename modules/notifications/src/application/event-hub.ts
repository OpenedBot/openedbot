import type { OrganizationEvent, RuntimeChangedFrame } from "@openedbot/contracts-events";

type Listener = (event: OrganizationEvent) => void;
type RuntimeChangedListener = (frame: RuntimeChangedFrame) => void;

function addListener<T>(map: Map<string, Set<T>>, organizationId: string, listener: T): () => void {
  const listeners = map.get(organizationId) ?? new Set<T>();
  listeners.add(listener);
  map.set(organizationId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) map.delete(organizationId);
  };
}

export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Control frames (`runtime.changed`): outside the event log and its cursor. */
  private readonly runtimeListeners = new Map<string, Set<RuntimeChangedListener>>();

  publish(event: OrganizationEvent): void {
    for (const listener of this.listeners.get(event.organizationId) ?? []) listener(event);
  }

  subscribe(organizationId: string, listener: Listener): () => void {
    return addListener(this.listeners, organizationId, listener);
  }

  publishRuntimeChanged(organizationId: string, frame: RuntimeChangedFrame): void {
    for (const listener of this.runtimeListeners.get(organizationId) ?? []) listener(frame);
  }

  subscribeRuntimeChanged(organizationId: string, listener: RuntimeChangedListener): () => void {
    return addListener(this.runtimeListeners, organizationId, listener);
  }

  /** Organizations with at least one open stream: a resync is sent to these. */
  runtimeSubscribedOrganizations(): string[] {
    return [...this.runtimeListeners.keys()];
  }

  subscriberCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}
