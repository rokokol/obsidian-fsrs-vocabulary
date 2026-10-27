import { describe, expect, it } from "vitest";
import { wordMatcher } from "../src/model/search";

const COLUMNS = ["word", "translation"];

function matches(query: string, row: Record<string, string>): boolean {
  return wordMatcher(query, COLUMNS)(row);
}

describe("wordMatcher", () => {
  it("matches a word by a part of it", () => {
    expect(matches("ste", { word: "steer", translation: "управлять" })).toBe(true);
    expect(matches("bri", { word: "steer", translation: "управлять" })).toBe(false);
  });

  it("matches the translation as well as the word", () => {
    expect(matches("управ", { word: "steer", translation: "управлять" })).toBe(true);
  });

  it("ignores letter case", () => {
    expect(matches("STEER", { word: "Steer", translation: "" })).toBe(true);
    expect(matches("УПРАВ", { word: "steer", translation: "Управлять" })).toBe(true);
  });

  it("treats ё and е as the same letter, both ways", () => {
    expect(matches("еж", { word: "hedgehog", translation: "ёжик" })).toBe(true);
    expect(matches("ёж", { word: "hedgehog", translation: "ежик" })).toBe(true);
    expect(matches("ЁЖ", { word: "hedgehog", translation: "ежик" })).toBe(true);
  });

  it("needs every word of the query, in any column and any order", () => {
    const row = { word: "take off", translation: "взлетать" };
    expect(matches("off взлет", row)).toBe(true);
    expect(matches("off приземл", row)).toBe(false);
  });

  it("does not match across the boundary of two cells", () => {
    expect(matches("rя", { word: "steer", translation: "я" })).toBe(false);
  });

  it("looks only at the given columns", () => {
    expect(matches("2026", { word: "steer", translation: "x", due: "2026-10-28" })).toBe(false);
  });

  it("lets every row through an empty or blank query", () => {
    expect(matches("", { word: "steer", translation: "" })).toBe(true);
    expect(matches("   ", { word: "steer", translation: "" })).toBe(true);
  });
});
