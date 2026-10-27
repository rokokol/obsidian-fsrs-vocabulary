import { State, type Card } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { newCard, review, type ReviewRating } from "../src/model/srs";
import { ReviewQueue, type QueueItem } from "../src/review/queue";

const NOW = new Date("2026-07-27T12:00:00Z");
const SCHEDULING = { retention: 0.9, weights: null };

function minutes(n: number): Date {
  return new Date(NOW.getTime() + n * 60_000);
}

interface Item extends QueueItem {
  name: string;
}

function item(name: string, card: Card = newCard(NOW), live = true): Item {
  return { name, card, live };
}

/** A card that was graded at `at`, so it carries the schedule that grade gives. */
function graded(rating: ReviewRating, at: Date = NOW): Card {
  return review(newCard(at), rating, SCHEDULING, at);
}

/** Grade whatever the queue offers next, as the modal would, and return its name. */
function answer(queue: ReviewQueue<Item>, rating: ReviewRating, at: Date): string | undefined {
  const next = queue.next(at);
  if (next) queue.graded(next, review(next.card, rating, SCHEDULING, at));
  return next?.name;
}

describe("ReviewQueue", () => {
  it("brings a card graded Again back once its step has passed, and not before", () => {
    const queue = new ReviewQueue([item("a"), item("b")]);
    expect(answer(queue, "again", NOW)).toBe("a");
    // The Again step is a minute or more: at the same instant only b is due.
    expect(answer(queue, "good", NOW)).toBe("b");
    expect(queue.next(NOW)).toBeNull();
    const due = queue.nextDue(NOW);
    expect(due).not.toBeNull();
    expect(queue.next(due ?? NOW)?.name).toBe("a");
  });

  it("does not show a card graded Good again within the session", () => {
    const queue = new ReviewQueue([item("a")]);
    answer(queue, "easy", NOW);
    expect(queue.next(minutes(60))).toBeNull();
  });

  it("takes in a card that was not due at the start once it becomes due", () => {
    const later = { ...newCard(NOW), due: minutes(5) };
    const queue = new ReviewQueue([item("now"), item("later", later)]);
    expect(answer(queue, "easy", NOW)).toBe("now");
    expect(queue.next(NOW)).toBeNull();
    expect(queue.next(minutes(5))?.name).toBe("later");
  });

  it("puts a due learning card ahead of review cards that come earlier in order", () => {
    const review1 = graded("easy", new Date("2026-07-01T12:00:00Z"));
    const review2 = graded("easy", new Date("2026-07-01T12:00:00Z"));
    expect(review1.state).toBe(State.Review);
    const learning = graded("again", minutes(-30));
    expect(learning.state).toBe(State.Learning);
    const queue = new ReviewQueue([item("r1", review1), item("r2", review2), item("l", learning)]);
    expect(queue.next(NOW)?.name).toBe("l");
  });

  it("orders due learning cards by their due time", () => {
    const early = { ...graded("again", minutes(-30)), due: minutes(-20) };
    const late = { ...graded("again", minutes(-30)), due: minutes(-10) };
    const queue = new ReviewQueue([item("late", late), item("early", early)]);
    expect(queue.next(NOW)?.name).toBe("early");
  });

  it("keeps the given order among cards that are not learning", () => {
    const queue = new ReviewQueue([item("x"), item("y"), item("z")]);
    expect([
      answer(queue, "easy", NOW),
      answer(queue, "easy", NOW),
      answer(queue, "easy", NOW),
    ]).toEqual(["x", "y", "z"]);
  });

  it("shows a card that is not live once, even though its due date never moves", () => {
    const queue = new ReviewQueue([item("p", newCard(NOW), false), item("q", newCard(NOW), false)]);
    const first = queue.next(NOW);
    if (first) queue.skipped(first);
    const second = queue.next(NOW);
    if (second) queue.skipped(second);
    expect([first?.name, second?.name]).toEqual(["p", "q"]);
    expect(queue.next(NOW)).toBeNull();
  });

  it("shows a card that is not live once, even when grading leaves it due", () => {
    // A pool-all session grades cards whose due date stays in the past after an
    // Again, so the due date alone cannot keep them from coming round again.
    const queue = new ReviewQueue([item("p", newCard(NOW), false)]);
    expect(answer(queue, "again", NOW)).toBe("p");
    expect(queue.next(minutes(60))).toBeNull();
  });

  it("offers a card that is not live even when it is not due", () => {
    const future = { ...newCard(NOW), due: minutes(600) };
    const queue = new ReviewQueue([item("p", future, false)]);
    expect(queue.next(NOW)?.name).toBe("p");
  });

  it("drops a card whose write failed", () => {
    const queue = new ReviewQueue([item("a"), item("b")]);
    const first = queue.next(NOW);
    if (first) queue.drop(first);
    expect(queue.next(NOW)?.name).toBe("b");
  });

  it("counts what was shown and what is waiting now", () => {
    const later = { ...newCard(NOW), due: minutes(5) };
    const queue = new ReviewQueue([item("a"), item("b"), item("later", later)]);
    expect(queue.remaining(NOW)).toBe(2);
    answer(queue, "easy", NOW);
    expect(queue.shown).toBe(1);
    expect(queue.remaining(NOW)).toBe(1);
    expect(queue.remaining(minutes(5))).toBe(2);
  });

  it("reports the next due date of a card still to come, not of one already due", () => {
    const later = { ...newCard(NOW), due: minutes(5) };
    const queue = new ReviewQueue([item("now"), item("later", later)]);
    expect(queue.nextDue(NOW)).toEqual(minutes(5));
  });

  it("leaves a dropped card out of the next due date", () => {
    const soon = { ...newCard(NOW), due: minutes(5) };
    const later = { ...newCard(NOW), due: minutes(9) };
    const queue = new ReviewQueue([item("soon", soon), item("later", later)]);
    const first = queue.next(minutes(5));
    if (first) queue.drop(first);
    expect(queue.nextDue(NOW)).toEqual(minutes(9));
  });

  it("reports no next due date when nothing live is left in the future", () => {
    const queue = new ReviewQueue([item("p", newCard(NOW), false)]);
    expect(queue.nextDue(NOW)).toBeNull();
  });
});
