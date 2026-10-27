import { State, type Card } from "ts-fsrs";
import { isDue } from "../model/srs";

/** What the queue needs to know about a card in the session. */
export interface QueueItem {
  card: Card;
  /**
   * Whether the card can come round again once its new due date arrives. True
   * for a recorded review of due cards. A practice run writes nothing, and an
   * all-cards pool selects a card whatever its due date, so in both a due date
   * cannot tell a card already answered from one still waiting: those cards are
   * shown once each.
   */
  live: boolean;
}

/**
 * The order of a review session, kept in memory and worked out again after
 * every answer. A card graded Again is due a minute later; a list fixed when
 * the session opened would never show it again, and the session would have to
 * be restarted to see it.
 *
 * Due dates come from the session's own grades rather than from re-reading the
 * notes. The review modal covers the workspace, so the notes do not change under
 * it in the normal course of things.
 */
export class ReviewQueue<T extends QueueItem> {
  private readonly items: T[];
  private readonly done = new Set<T>();
  private count = 0;

  /** `items` in session order: file order, or shuffled when the session asked for it. */
  constructor(items: readonly T[]) {
    this.items = [...items];
  }

  /** How many cards were answered or skipped. */
  get shown(): number {
    return this.count;
  }

  /**
   * The card to show at `now`, or null when nothing is waiting. A learning card
   * goes first, earliest due first: its steps are minutes long, and waiting
   * behind a long run of review cards would stretch a one-minute step to a
   * quarter of an hour. The rest keep the session order.
   */
  next(now: Date): T | null {
    let learning: T | null = null;
    let other: T | null = null;
    for (const item of this.items) {
      if (!this.waiting(item, now)) continue;
      if (item.live && ReviewQueue.learning(item.card)) {
        if (!learning || item.card.due.getTime() < learning.card.due.getTime()) learning = item;
      } else {
        other ??= item;
      }
    }
    return learning ?? other;
  }

  /** How many cards are waiting at `now`, the one on screen included. */
  remaining(now: Date): number {
    return this.items.filter((item) => this.waiting(item, now)).length;
  }

  /** When the earliest card that is not yet due becomes due, or null if none will. */
  nextDue(now: Date): Date | null {
    let earliest: Date | null = null;
    for (const item of this.items) {
      if (!item.live || this.done.has(item) || isDue(item.card, now)) continue;
      if (!earliest || item.card.due.getTime() < earliest.getTime()) earliest = item.card.due;
    }
    return earliest;
  }

  /** Record a grade that reached the disk: the card now waits for its new due date. */
  graded(item: T, card: Card): void {
    item.card = card;
    this.count += 1;
    if (!item.live) this.done.add(item);
  }

  /** Move past a card without grading it (practice runs). */
  skipped(item: T): void {
    this.count += 1;
    this.done.add(item);
  }

  /** Take a card out of the session, as when its row went away. */
  drop(item: T): void {
    this.done.add(item);
  }

  private waiting(item: T, now: Date): boolean {
    if (this.done.has(item)) return false;
    return !item.live || isDue(item.card, now);
  }

  private static learning(card: Card): boolean {
    return card.state === State.Learning || card.state === State.Relearning;
  }
}
