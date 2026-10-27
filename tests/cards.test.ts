import { createEmptyCard, State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { findCardRow, isCardRow, tableCards } from "../src/model/cards";
import { encodeCard } from "../src/model/srs";

const NOW = new Date("2026-01-10T00:00:00.000Z");

function scheduled(due: Date, state: State = State.Review): string {
  return encodeCard({ ...createEmptyCard(NOW), due, state }, "c1");
}

describe("isCardRow", () => {
  it("counts a row whose only front column is filled", () => {
    expect(isCardRow({ word: "a" }, ["word"])).toBe(true);
  });

  it("rejects empty, blank and absent front cells", () => {
    expect(isCardRow({ word: "" }, ["word"])).toBe(false);
    expect(isCardRow({ word: "   " }, ["word"])).toBe(false);
    expect(isCardRow({ translation: "x" }, ["word"])).toBe(false);
  });

  it("counts a row where any one of several front columns is filled", () => {
    // A multi-column front asks with what it has; requiring all of them would
    // silently drop half-filled rows from both the count and the session.
    expect(isCardRow({ word: "a", transcription: "" }, ["word", "transcription"])).toBe(true);
    expect(isCardRow({ word: "", transcription: "" }, ["word", "transcription"])).toBe(false);
  });

  it("counts nothing when there are no front columns", () => {
    expect(isCardRow({ word: "a" }, [])).toBe(false);
  });
});

describe("tableCards", () => {
  it("takes one card per card row, in file order", () => {
    const rows = [{ word: "a" }, { word: "" }, { word: "b" }];
    expect(tableCards(rows, ["word"], NOW)).toHaveLength(2);
  });

  it("reads the schedule from the srs cell", () => {
    const due = new Date("2026-02-01T00:00:00.000Z");
    const cards = tableCards([{ word: "a", srs: scheduled(due) }], ["word"], NOW);
    expect(cards[0]?.due.toISOString()).toBe(due.toISOString());
    expect(cards[0]?.state).toBe(State.Review);
  });

  it("treats a row with no srs cell as a new card due now", () => {
    const cards = tableCards([{ word: "a" }], ["word"], NOW);
    expect(cards[0]?.state).toBe(State.New);
    expect(cards[0]?.due.getTime()).toBe(NOW.getTime());
  });

  it("treats an unreadable srs cell as a new card rather than dropping the row", () => {
    const cards = tableCards([{ word: "a", srs: "not-a-card" }], ["word"], NOW);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.state).toBe(State.New);
  });

  it("returns nothing when the front column is not in the table", () => {
    expect(tableCards([{ word: "a" }], [], NOW)).toEqual([]);
    expect(tableCards([{ word: "a" }], ["missing"], NOW)).toEqual([]);
  });
});

describe("findCardRow", () => {
  function row(word: string, id: string | null): Record<string, string> {
    const srs = id === null ? "" : encodeCard(createEmptyCard(NOW), id);
    return { word, srs };
  }

  it("takes the row at the remembered index when it holds the same card", () => {
    const rows = [row("a", "c1"), row("b", "c2")];
    expect(findCardRow(rows, 1, "c2", { word: "b" })).toBe(1);
  });

  it("prefers the remembered row among id-less rows sharing a word", () => {
    const rows = [row("a", null), row("a", null)];
    expect(findCardRow(rows, 1, "fresh", { word: "a" })).toBe(1);
  });

  it("finds a card by its id after its row moved", () => {
    const rows = [row("b", "c2"), row("a", "c1")];
    expect(findCardRow(rows, 0, "c1", { word: "a" })).toBe(1);
  });

  it("finds a card with no id yet by its front after its row moved", () => {
    const rows = [row("b", null), row("a", null)];
    expect(findCardRow(rows, 0, "fresh", { word: "a" })).toBe(1);
  });

  it("does not take a row holding another card with the same front", () => {
    // The id decides when the row has one: two rows can share a word.
    const rows = [row("a", "c9")];
    expect(findCardRow(rows, 0, "c1", { word: "a" })).toBe(-1);
  });

  it("does not take an id-less row with another front", () => {
    const rows = [row("b", null)];
    expect(findCardRow(rows, 0, "fresh", { word: "a" })).toBe(-1);
  });

  it("says -1 when the card is gone", () => {
    expect(findCardRow([], 3, "c1", { word: "a" })).toBe(-1);
  });
});
