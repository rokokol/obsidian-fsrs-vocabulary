import { describe, expect, it } from "vitest";
import {
  clampRemindMinutes,
  frontColumnFor,
  DEFAULT_SETTINGS,
  MAX_REMIND_MINUTES,
  migrateSettings,
  readControl,
  RETENTION_MAX,
  RETENTION_MIN,
  sanitizePropertyKeys,
  selectProperties,
  writeControl,
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

/** A settings object to change, so one test never sees another's writes. */
const fresh = (): FsrsVocabularySettings => ({
  ...DEFAULT_SETTINGS,
  newDictionaryColumns: [...DEFAULT_SETTINGS.newDictionaryColumns],
  properties: [...DEFAULT_SETTINGS.properties],
});

describe("readControl", () => {
  it("shows a list setting as the text the field holds", () => {
    const settings = { ...fresh(), newDictionaryColumns: ["word", "meaning"], properties: ["up"] };
    expect(readControl(settings, "newDictionaryColumns")).toBe("word, meaning");
    expect(readControl(settings, "properties")).toBe("up");
  });

  it("shows a plain setting as it is", () => {
    const settings = { ...fresh(), defaultSort: "due-asc" as const, remindEveryMinutes: 30 };
    expect(readControl(settings, "defaultSort")).toBe("due-asc");
    expect(readControl(settings, "remindEveryMinutes")).toBe(30);
    expect(readControl(settings, "remindersEnabled")).toBe(true);
  });

  it("knows nothing of a key that is not a control", () => {
    // `fsrsWeights` is stored but has no field of its own: the tab must not echo it
    expect(readControl(fresh(), "fsrsWeights")).toBeUndefined();
    expect(readControl(fresh(), "nonsense")).toBeUndefined();
  });
});

describe("writeControl", () => {
  it("stores a toggle and reports what must be redone", () => {
    const settings = fresh();
    expect(writeControl(settings, "statsIncludeMuted", true)).toEqual(["rendered"]);
    expect(settings.statsIncludeMuted).toBe(true);
    expect(writeControl(settings, "remindersEnabled", false)).toEqual(["reminders"]);
    expect(settings.remindersEnabled).toBe(false);
    expect(writeControl(settings, "statusBarCounter", false)).toEqual(["reminders"]);
    expect(writeControl(settings, "iconicIntegration", true)).toEqual(["iconic"]);
    expect(writeControl(settings, "keepQuestionOnReveal", false)).toEqual([]);
    expect(writeControl(settings, "remindOnStartup", false)).toEqual([]);
  });

  it("refuses a value of the wrong kind and leaves the setting alone", () => {
    const settings = fresh();
    expect(writeControl(settings, "remindersEnabled", "yes")).toBeNull();
    expect(writeControl(settings, "remindEveryMinutes", "30")).toBeNull();
    expect(writeControl(settings, "newDictionaryColumns", 3)).toBeNull();
    expect(settings).toEqual(fresh());
  });

  it("refuses a key that is not a control", () => {
    const settings = fresh();
    expect(writeControl(settings, "fsrsWeights", [1, 2, 3])).toBeNull();
    expect(writeControl(settings, "nonsense", true)).toBeNull();
    expect(settings).toEqual(fresh());
  });

  it("stores typed columns cleaned, and keeps the old ones when nothing usable is left", () => {
    const settings = fresh();
    expect(writeControl(settings, "newDictionaryColumns", "word,  meaning\nword, due, ")).toEqual(
      [],
    );
    // `due` is a column the plugin manages itself, so it cannot be a content column
    expect(settings.newDictionaryColumns).toEqual(["word", "meaning"]);
    expect(writeControl(settings, "newDictionaryColumns", " , due")).toBeNull();
    expect(settings.newDictionaryColumns).toEqual(["word", "meaning"]);
  });

  it("stores typed properties cleaned, and lets the list be emptied", () => {
    const settings = fresh();
    expect(writeControl(settings, "properties", "up, source\nup")).toEqual(["rendered"]);
    expect(settings.properties).toEqual(["up", "source"]);
    // An empty list is a real choice here: it shows every property
    expect(writeControl(settings, "properties", "")).toEqual(["rendered"]);
    expect(settings.properties).toEqual([]);
  });

  it("accepts only the views, orders and scopes there are", () => {
    const settings = fresh();
    expect(writeControl(settings, "defaultView", "markdown")).toEqual([]);
    expect(settings.defaultView).toBe("markdown");
    expect(writeControl(settings, "defaultView", "sideways")).toBeNull();
    expect(settings.defaultView).toBe("markdown");

    expect(writeControl(settings, "defaultSort", "shuffled")).toEqual([]);
    expect(writeControl(settings, "defaultSort", "newest")).toBeNull();
    expect(settings.defaultSort).toBe("shuffled");

    expect(writeControl(settings, "reviewScope", "vault")).toEqual([]);
    expect(writeControl(settings, "reviewScope", "galaxy")).toBeNull();
    expect(settings.reviewScope).toBe("vault");
  });

  it("keeps the target retention inside the slider's range, in hundredths", () => {
    const settings = fresh();
    writeControl(settings, "fsrsRetention", 0.8500000000000001);
    expect(settings.fsrsRetention).toBe(0.85);
    writeControl(settings, "fsrsRetention", 0.2);
    expect(settings.fsrsRetention).toBe(RETENTION_MIN);
    writeControl(settings, "fsrsRetention", 1);
    expect(settings.fsrsRetention).toBe(RETENTION_MAX);
    expect(writeControl(settings, "fsrsRetention", Number.NaN)).toBeNull();
    expect(settings.fsrsRetention).toBe(RETENTION_MAX);
  });

  it("makes the reminder interval a whole number of minutes no longer than a week", () => {
    const settings = fresh();
    expect(writeControl(settings, "remindEveryMinutes", 45)).toEqual(["reminders"]);
    expect(settings.remindEveryMinutes).toBe(45);
    writeControl(settings, "remindEveryMinutes", 12.6);
    expect(settings.remindEveryMinutes).toBe(13);
    writeControl(settings, "remindEveryMinutes", 999999);
    expect(settings.remindEveryMinutes).toBe(MAX_REMIND_MINUTES);
    writeControl(settings, "remindEveryMinutes", 0);
    expect(settings.remindEveryMinutes).toBe(0);
  });

  it("never lets a negative or unreadable interval reach the timer", () => {
    const settings = { ...fresh(), remindEveryMinutes: 45 };
    expect(writeControl(settings, "remindEveryMinutes", -5)).toBeNull();
    expect(writeControl(settings, "remindEveryMinutes", Number.NaN)).toBeNull();
    expect(writeControl(settings, "remindEveryMinutes", Infinity)).toBeNull();
    expect(settings.remindEveryMinutes).toBe(45);
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
    const fsrsFit = {
      at: 1000,
      items: 420,
      status: "adopted",
      lossBefore: 0.4,
      lossAfter: 0.3,
    } as const;
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
