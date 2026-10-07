import type { Card } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import {
  cardFromCell,
  decodeCard,
  dueDateString,
  encodeCard,
  isDue,
  newCard,
  rescheduleCard,
  review,
} from "../src/model/srs";

describe("srs encode/decode", () => {
  it("round-trips a card", () => {
    const card = newCard(new Date("2026-07-07T00:00:00Z"));
    const decoded = decodeCard(encodeCard(card));
    expect(decoded).not.toBeNull();
    expect(decoded?.reps).toBe(card.reps);
    expect(decoded?.state).toBe(card.state);
    expect(decoded?.due.toISOString()).toBe(card.due.toISOString());
  });

  it("round-trips the learning step a card is on", () => {
    // A learning card graded Good moves to its second step; losing that on disk
    // would send it back to the first step on every review.
    const now = new Date("2026-07-07T00:00:00Z");
    const learning = review(newCard(now), "good", 0.9, now);
    expect(learning.learning_steps).toBeGreaterThan(0);
    expect(decodeCard(encodeCard(learning))?.learning_steps).toBe(learning.learning_steps);
  });

  it("reads a cell written before learning steps were stored as the first step", () => {
    const cell = '{"s":1,"r":1,"l":0,"S":2.3,"D":5.1,"e":0,"c":0,"d":"2026-07-07T00:10:00.000Z"}';
    expect(decodeCard(cell)?.learning_steps).toBe(0);
  });

  it("treats blank and malformed cells as new cards", () => {
    expect(decodeCard("")).toBeNull();
    expect(decodeCard("not json")).toBeNull();
    expect(decodeCard("{}")).toBeNull();
    expect(cardFromCell("").reps).toBe(0);
  });
});

describe("srs scheduling", () => {
  it("a new card is due immediately", () => {
    const card = newCard(new Date("2026-07-07T00:00:00Z"));
    expect(isDue(card, new Date("2026-07-07T01:00:00Z"))).toBe(true);
  });

  it("a 'good' review pushes the due date into the future", () => {
    const now = new Date("2026-07-07T00:00:00Z");
    const card = newCard(now);
    const next = review(card, "good", 0.9, now);
    expect(next.due.getTime()).toBeGreaterThan(now.getTime());
    expect(next.reps).toBe(1);
    expect(dueDateString(next)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("'again' schedules sooner than 'easy'", () => {
    const now = new Date("2026-07-07T00:00:00Z");
    const card = newCard(now);
    const again = review(card, "again", 0.9, now).due.getTime();
    const easy = review(card, "easy", 0.9, now).due.getTime();
    expect(again).toBeLessThan(easy);
  });
});

describe("rescheduleCard", () => {
  const now = new Date("2026-07-07T00:00:00Z");

  /** A card in the review state, which is the only state retention has a say in. */
  function reviewed(retention = 0.9): Card {
    let card = newCard(new Date("2026-01-01T00:00:00Z"));
    // Three good reviews are enough to graduate out of learning.
    for (const day of ["2026-01-01", "2026-01-02", "2026-02-01"]) {
      card = review(card, "good", retention, new Date(`${day}T00:00:00Z`));
    }
    return card;
  }

  it("gives a longer interval for a lower target retention", () => {
    // Asking to remember less means being willing to wait longer, which is the whole
    // reason the setting exists — and why the dates already on disk are stale after
    // it changes.
    const card = reviewed();
    const relaxed = rescheduleCard(card, 0.7, now);
    const strict = rescheduleCard(card, 0.97, now);
    expect(relaxed).not.toBeNull();
    expect(strict).not.toBeNull();
    expect(relaxed?.due.getTime()).toBeGreaterThan(strict?.due.getTime() ?? 0);
  });

  it("leaves the memory model alone, moving only the interval", () => {
    const card = reviewed();
    const next = rescheduleCard(card, 0.7, now);
    expect(next?.stability).toBe(card.stability);
    expect(next?.difficulty).toBe(card.difficulty);
    expect(next?.reps).toBe(card.reps);
    expect(next?.lapses).toBe(card.lapses);
    expect(next?.last_review).toEqual(card.last_review);
  });

  it("counts the new interval from the last review, not from today", () => {
    const card = reviewed();
    const next = rescheduleCard(card, 0.7, now);
    const days = (next?.scheduled_days ?? 0) * 24 * 60 * 60 * 1000;
    expect(next?.due.getTime()).toBe((card.last_review?.getTime() ?? 0) + days);
  });

  it("says there is nothing to do when the target has not changed", () => {
    // What keeps a second run from rewriting every file it just wrote.
    const card = reviewed(0.9);
    expect(rescheduleCard(card, 0.9, now)).toBeNull();
  });

  it("does not touch a card that is not in the review state", () => {
    // A new card is due now by definition; learning steps are fixed minutes that
    // retention has no say in.
    expect(rescheduleCard(newCard(now), 0.7, now)).toBeNull();
    const learning = review(newCard(now), "good", 0.9, now);
    expect(rescheduleCard(learning, 0.7, now)).toBeNull();
  });
});
