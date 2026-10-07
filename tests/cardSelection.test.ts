import { State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { newCard, review } from "../src/model/srs";
import { defaultOptions, selectsCard, type ReviewOptions } from "../src/review/options";

const NOW = new Date("2026-07-27T12:00:00Z");
const HEADERS = ["word", "translation", "due", "srs"];

function options(overrides: Partial<ReviewOptions> = {}): ReviewOptions {
  return { ...defaultOptions(HEADERS), ...overrides };
}

/** A card scheduled into the future, i.e. not due at NOW. */
function scheduled(): ReturnType<typeof newCard> {
  return review(newCard(NOW), "easy", { retention: 0.9, weights: null }, NOW);
}

describe("selectsCard", () => {
  it("keeps a due card and rejects a scheduled one under the due pool", () => {
    expect(selectsCard(newCard(NOW), options(), NOW)).toBe(true);
    expect(selectsCard(scheduled(), options(), NOW)).toBe(false);
  });

  it("keeps everything under the all pool", () => {
    const pool = options({ pool: "all" });
    expect(selectsCard(newCard(NOW), pool, NOW)).toBe(true);
    expect(selectsCard(scheduled(), pool, NOW)).toBe(true);
  });

  it("treats a card due exactly now as due", () => {
    const card = { ...newCard(NOW), due: NOW };
    expect(selectsCard(card, options(), NOW)).toBe(true);
  });

  it("filters by state when asked", () => {
    const fresh = newCard(NOW);
    expect(selectsCard(fresh, options({ pool: "all", states: [State.New] }), NOW)).toBe(true);
    expect(selectsCard(fresh, options({ pool: "all", states: [State.Review] }), NOW)).toBe(false);
  });

  it("composes the pool and the state filter", () => {
    // A scheduled card is in the Review state but is not due: the due pool must
    // still reject it, so a "Review" tile under the due pool yields fewer cards.
    const card = scheduled();
    expect(selectsCard(card, options({ states: [State.Review] }), NOW)).toBe(false);
    expect(selectsCard(card, options({ pool: "all", states: [State.Review] }), NOW)).toBe(true);
  });

  it("reads an empty state list as no filter, not as nothing matches", () => {
    expect(selectsCard(newCard(NOW), options({ states: [] }), NOW)).toBe(true);
  });
});
