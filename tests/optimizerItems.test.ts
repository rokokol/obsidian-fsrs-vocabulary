import { State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import type { ReviewLogEntry } from "../src/model/history";
import { buildItems } from "../src/optimizer/items";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 10, 0);

const log = (c: string, day: number, r: ReviewLogEntry["r"], s: State, hour = 0): ReviewLogEntry => ({
  c,
  t: T0 + day * DAY + hour * 60 * 60 * 1000,
  r,
  s,
});

describe("buildItems", () => {
  it("makes one item per review after the first, each carrying the card's history", () => {
    const items = buildItems([
      log("a", 0, 3, State.New),
      log("a", 2, 3, State.Review),
      log("a", 7, 1, State.Review),
    ]);
    expect(items.map((item) => item.reviews)).toEqual([
      [
        { rating: 3, deltaT: 0 },
        { rating: 3, deltaT: 2 },
      ],
      [
        { rating: 3, deltaT: 0 },
        { rating: 3, deltaT: 2 },
        { rating: 1, deltaT: 5 },
      ],
    ]);
  });

  it("keeps same-day reviews in the history but asks no question about them", () => {
    // A same-day review is a learning step: FSRS models it inside the history, and
    // only a review on a later day is a test of long-term memory worth predicting.
    const items = buildItems([
      log("a", 0, 1, State.New),
      log("a", 0, 3, State.Learning, 1),
      log("a", 1, 3, State.Review),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.reviews).toEqual([
      { rating: 1, deltaT: 0 },
      { rating: 3, deltaT: 0 },
      { rating: 3, deltaT: 1 },
    ]);
  });

  it("counts days the way the scheduler does, by calendar date in UTC", () => {
    // 23:00 to 01:00 the next day is two hours and one day.
    const late = Date.UTC(2026, 9, 1, 23, 0);
    const items = buildItems([
      { c: "a", t: late, r: 3, s: State.New },
      { c: "a", t: late + 2 * 60 * 60 * 1000, r: 3, s: State.Learning },
    ]);
    expect(items[0]?.reviews[1]?.deltaT).toBe(1);
  });

  it("leaves out a card whose first logged review was not its first review", () => {
    // Reviewed before logging began: its history here starts in the middle, and
    // FSRS would read it as a new card.
    const items = buildItems([
      log("old", 0, 3, State.Review),
      log("old", 5, 3, State.Review),
      log("new", 0, 3, State.New),
      log("new", 3, 3, State.Review),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.reviews.map((review) => review.deltaT)).toEqual([0, 3]);
  });

  it("orders items by when they were answered, across cards, and numbers cards", () => {
    const items = buildItems([
      log("a", 0, 3, State.New),
      log("b", 1, 3, State.New),
      log("b", 2, 3, State.Review),
      log("a", 4, 3, State.Review),
    ]);
    expect(items.map((item) => item.time)).toEqual([T0 + 2 * DAY, T0 + 4 * DAY]);
    expect(new Set(items.map((item) => item.card)).size).toBe(2);
  });

  it("does not depend on the order the log arrives in", () => {
    const entries = [
      log("a", 0, 3, State.New),
      log("a", 2, 3, State.Review),
      log("a", 7, 1, State.Review),
    ];
    expect(buildItems([...entries].reverse())).toEqual(buildItems(entries));
  });
});
