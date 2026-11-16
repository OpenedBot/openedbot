import { Component, lazy, memo, Suspense, type ComponentType, type CSSProperties, type ReactNode } from "react";
import type { RunCard, RunCardKind } from "@openedbot/contracts-events";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import { runCardRegistration } from "../../lib/cards/run-card-registry";

const lazyCards = new Map<RunCardKind, ComponentType<{ card: RunCard }>>();

function lazyCard(kind: RunCardKind): ComponentType<{ card: RunCard }> | null {
  const registration = runCardRegistration(kind);
  if (!registration) return null;
  let card = lazyCards.get(kind);
  if (!card) {
    card = lazy(registration.load);
    lazyCards.set(kind, card);
  }
  return card;
}

/**
 * A card that fails (its chunk did not load, a render threw) takes itself out
 * rather than the thread: the bot's text around it still says the answer.
 */
class RunCardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The room a card takes while its chunk loads, at the card's own height. It
 * holds the thread's first reveal like an image does (bounded wait,
 * `thread-initial-layout.tsx`).
 */
export function RunCardPlaceholder({ card }: { card: RunCard }) {
  const registration = runCardRegistration(card.kind);
  if (!registration) return null;
  return (
    <div
      aria-hidden="true"
      data-run-card-placeholder={card.kind}
      data-thread-layout-pending=""
      style={{ "--wx-rest": registration.placeholderHeight(card) } as CSSProperties}
      className="openedbot-run-card-placeholder w-full rounded-[1.375rem] border border-border/60 bg-surface"
    />
  );
}

/** One card, by kind: its placeholder while its chunk loads, nothing for a kind this console does not know. */
export const RunCardView = memo(function RunCardView({ card }: { card: RunCard }) {
  const Card = lazyCard(card.kind);
  if (!Card) return null;
  return (
    <div data-run-card-frame="" className="openedbot-run-card">
      <RunCardBoundary>
        <Suspense fallback={<RunCardPlaceholder card={card} />}>
          <Card card={card} />
        </Suspense>
      </RunCardBoundary>
    </div>
  );
});

export function callsHaveCards(calls: readonly ToolCall[]): boolean {
  return calls.some((call) => (call.cards?.length ?? 0) > 0);
}

/**
 * The cards of a tool passage, as a block of the transcript at the passage's
 * place, across the reading lane. Outside any prose: the bubble styles must
 * not reach inside a card.
 */
export const ToolCallCards = memo(function ToolCallCards({ calls }: { calls: readonly ToolCall[] }) {
  return (
    <div data-run-cards="" className="not-prose flex w-full min-w-0 flex-col gap-3 self-stretch">
      {calls.flatMap((call, callIndex) =>
        (call.cards ?? []).map((card, cardIndex) => <RunCardView key={`${callIndex}:${cardIndex}`} card={card} />))}
    </div>
  );
});
