import { default_w, State, type Card } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import type { ReviewLogEntry } from "../src/model/history";
import { memoryFromLog, replayIndex } from "../src/model/replay";
import { gradeOf, newCard, review, type ReviewRating } from "../src/model/srs";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 9);
const at = { retention: 0.9, weights: null };

/** Grade a card through the plugin's own scheduler, logging each grade as the modal does. */
function graded(ratings: [number, ReviewRating][], id = "a1"): { card: Card; log: ReviewLogEntry[] } {
  let card = newCard(new Date(T0));
  const log: ReviewLogEntry[] = [];
  for (const [day, rating] of ratings) {
    const now = new Date(T0 + day * DAY);
    log.push({ c: id, t: now.getTime(), r: gradeOf(rating), s: card.state });
    card = review(card, rating, at, now);
  }
  return { card, log };
}

describe("memoryFromLog", () => {
  const steps: [number, ReviewRating][] = [
    [0, "good"],
    [1, "good"],
    [5, "again"],
    [6, "good"],
    [20, "good"],
  ];

  it("gives back the stored memory when replayed with the weights it was graded with", () => {
    const { card, log } = graded(steps);
    const memory = memoryFromLog(log, card, null);
    expect(memory?.stability).toBeCloseTo(card.stability, 3);
    expect(memory?.difficulty).toBeCloseTo(card.difficulty, 3);
  });

  it("gives a different memory under other weights", () => {
    const { card, log } = graded(steps);
    const weights = [...default_w];
    weights[3] = (weights[3] ?? 0) * 3; // a first Easy answer would last longer…
    weights[2] = (weights[2] ?? 0) * 3; // …and so would a first Good one
    const memory = memoryFromLog(log, card, weights);
    expect(memory?.stability).not.toBeCloseTo(card.stability, 3);
  });

  it("does not trust a log that does not reach the card's last review", () => {
    // A grade that never made it into the log (a failed append, a device whose log
    // has not synced yet) means the replay would describe a different card.
    const { card, log } = graded(steps);
    expect(memoryFromLog(log.slice(0, -1), card, null)).toBeNull();
  });

  it("does not trust a log that starts in the middle of the card's history", () => {
    const { card, log } = graded(steps);
    expect(memoryFromLog(log.slice(1), card, null)).toBeNull();
  });

  it("has nothing for a card that has no log", () => {
    const { card } = graded(steps);
    expect(memoryFromLog([], card, null)).toBeNull();
  });
});

describe("replayIndex", () => {
  it("groups the log by card, in time order", () => {
    const a = graded([[0, "good"], [2, "good"]], "a1").log;
    const b = graded([[1, "easy"]], "b2").log;
    const index = replayIndex([...b, ...a].reverse());
    expect(index.get("a1")).toEqual(a);
    expect(index.get("b2")).toEqual(b);
    expect(index.get("c3")).toBeUndefined();
  });
});

describe("a card graded before logging began", () => {
  it("is left to its stored memory", () => {
    const { card } = graded([[0, "good"], [1, "good"]]);
    const late: ReviewLogEntry[] = [{ c: "a1", t: card.last_review?.getTime() ?? 0, r: 3, s: State.Review }];
    expect(memoryFromLog(late, card, null)).toBeNull();
  });
});
