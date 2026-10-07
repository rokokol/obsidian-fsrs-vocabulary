import { describe, expect, it } from "vitest";
import {
  clampRemindMinutes,
  frontColumnFor,
  MAX_REMIND_MINUTES,
  migrateSettings,
  parseRemindMinutes,
  sanitizePropertyKeys,
  selectProperties,
  type FsrsVocabularySettings,
} from "../src/settings";

describe("frontColumnFor", () => {
  it("takes the first non-managed header", () => {
    expect(frontColumnFor(["word", "translation", "due", "srs"])).toBe("word");
  });

  it("skips managed columns wherever they sit", () => {
    expect(frontColumnFor(["due", "srs", "word", "translation"])).toBe("word");
  });

  it("is empty for a table with nothing but managed columns", () => {
    // Callers read "" as "not a usable words table", so it must not fall back to
    // a managed header.
    expect(frontColumnFor(["due", "srs"])).toBe("");
    expect(frontColumnFor([])).toBe("");
  });
});

describe("sanitizePropertyKeys", () => {
  it("splits on commas and newlines, trims, and dedupes", () => {
    expect(sanitizePropertyKeys("level, author\n level ")).toEqual(["level", "author"]);
  });

  it("keeps every key as-is (no filtering)", () => {
    expect(sanitizePropertyKeys("up\nsource\nrelated\ntags\nlevel")).toEqual([
      "up",
      "source",
      "related",
      "tags",
      "level",
    ]);
  });

  it("returns an empty list for blank input", () => {
    expect(sanitizePropertyKeys("  \n , ")).toEqual([]);
  });
});

describe("selectProperties", () => {
  const entries: [string, unknown][] = [
    ["level", "B2"],
    ["source", "Oxford"],
    ["author", "me"],
  ];

  it("returns all entries when the allow-list is empty", () => {
    expect(selectProperties(entries, [])).toEqual(entries);
  });

  it("keeps only allowed keys, in allow-list order", () => {
    expect(selectProperties(entries, ["source", "level"])).toEqual([
      ["source", "Oxford"],
      ["level", "B2"],
    ]);
  });

  it("ignores allowed keys that are absent", () => {
    expect(selectProperties(entries, ["missing", "author"])).toEqual([["author", "me"]]);
  });
});

describe("parseRemindMinutes", () => {
  it("reads a plain number of minutes", () => {
    expect(parseRemindMinutes("45", 0)).toBe(45);
  });

  it("reads a cleared field as start-up only", () => {
    expect(parseRemindMinutes("", 45)).toBe(0);
    expect(parseRemindMinutes("   ", 45)).toBe(0);
  });

  it("keeps the current value when the text is not a number", () => {
    expect(parseRemindMinutes("soon", 45)).toBe(45);
    expect(parseRemindMinutes("-5", 45)).toBe(45);
  });

  it("rounds fractions to whole minutes", () => {
    expect(parseRemindMinutes("12.6", 0)).toBe(13);
  });

  it("caps the interval at a week", () => {
    expect(parseRemindMinutes("999999", 0)).toBe(MAX_REMIND_MINUTES);
  });

  it("rounds a sub-minute interval to the nearest whole minute", () => {
    expect(parseRemindMinutes("0.4", 30)).toBe(0);
    expect(parseRemindMinutes("0.6", 30)).toBe(1);
  });
});

describe("migrateSettings", () => {
  it("converts a stored hours interval into minutes", () => {
    expect(migrateSettings({ remindEveryHours: 3 })).toEqual({ remindEveryMinutes: 180 });
  });

  it("drops the old key once it has been read", () => {
    expect(migrateSettings({ remindEveryHours: 1 })).not.toHaveProperty("remindEveryHours");
  });

  it("leaves an already-migrated value alone", () => {
    expect(migrateSettings({ remindEveryHours: 3, remindEveryMinutes: 10 })).toEqual({
      remindEveryMinutes: 10,
    });
  });

  it("clamps a negative stored interval to start-up only", () => {
    // A negative period reaches setInterval, which clamps it to no delay at all
    // and then fires a notice on every tick.
    expect(migrateSettings({ remindEveryHours: -1 })).toEqual({ remindEveryMinutes: 0 });
    expect(migrateSettings({ remindEveryMinutes: -5 })).toEqual({ remindEveryMinutes: 0 });
  });

  it("clamps a non-numeric stored interval to start-up only", () => {
    expect(migrateSettings({ remindEveryHours: NaN })).toEqual({ remindEveryMinutes: 0 });
    expect(migrateSettings({ remindEveryMinutes: Infinity })).toEqual({ remindEveryMinutes: 0 });
    expect(
      migrateSettings({
        remindEveryMinutes: "soon",
      } as unknown as Partial<FsrsVocabularySettings>),
    ).toEqual({ remindEveryMinutes: 0 });
  });

  it("clamps an out-of-range value stored under the current key", () => {
    expect(migrateSettings({ remindEveryMinutes: 999999 })).toEqual({
      remindEveryMinutes: MAX_REMIND_MINUTES,
    });
  });

  it("caps a hours value that would overflow the field", () => {
    expect(migrateSettings({ remindEveryHours: 1000 })).toEqual({
      remindEveryMinutes: MAX_REMIND_MINUTES,
    });
  });

  it("passes everything else through untouched", () => {
    expect(migrateSettings({ fsrsRetention: 0.8 })).toEqual({ fsrsRetention: 0.8 });
  });

  it("keeps a full set of FSRS-6 weights", () => {
    const weights = Array.from({ length: 21 }, (_, i) => i / 10);
    expect(migrateSettings({ fsrsWeights: weights })).toEqual({ fsrsWeights: weights });
  });

  it("keeps the record of the last fit", () => {
    const fsrsFit = { at: 1000, items: 420, status: "adopted", lossBefore: 0.4, lossAfter: 0.3 } as const;
    expect(migrateSettings({ fsrsFit })).toEqual({ fsrsFit });
  });

  it("forgets a fit record it cannot read", () => {
    // The record decides when the next automatic fit runs; a broken one should
    // mean "no fit yet", not a timer that never fires.
    const broken = [
      { at: 1000, items: "420", status: "adopted", lossBefore: 0.4, lossAfter: 0.3 },
      { at: 1000, items: 420, status: "maybe", lossBefore: 0.4, lossAfter: 0.3 },
      { at: 1000, items: 420, status: "kept", lossBefore: "0.4", lossAfter: 0.3 },
      { at: null, items: 420, status: "kept", lossBefore: 0.4, lossAfter: 0.3 },
      "yesterday",
    ];
    for (const fsrsFit of broken) {
      expect(migrateSettings({ fsrsFit } as never)).toEqual({ fsrsFit: null });
    }
  });

  it("falls back to the default weights for a set the scheduler cannot use", () => {
    // `data.json` is a plain file; weights of another FSRS version, or a hand edit,
    // must not reach the scheduler, which would throw on every grade.
    const short = Array.from({ length: 19 }, () => 1);
    const broken = [...Array.from({ length: 20 }, () => 1), Number.NaN];
    const text = Array.from({ length: 21 }, () => "1") as unknown as number[];
    for (const fsrsWeights of [short, broken, text]) {
      expect(migrateSettings({ fsrsWeights })).toEqual({ fsrsWeights: null });
    }
  });
});

describe("clampRemindMinutes", () => {
  it("passes a sane interval through", () => {
    expect(clampRemindMinutes(30)).toBe(30);
  });

  it("turns anything that is not a usable number into start-up only", () => {
    expect(clampRemindMinutes(-1)).toBe(0);
    expect(clampRemindMinutes(NaN)).toBe(0);
    expect(clampRemindMinutes(Infinity)).toBe(0);
    expect(clampRemindMinutes("30")).toBe(0);
    expect(clampRemindMinutes(undefined)).toBe(0);
  });

  it("caps at a week", () => {
    expect(clampRemindMinutes(MAX_REMIND_MINUTES + 1)).toBe(MAX_REMIND_MINUTES);
  });
});
