import { describe, expect, it } from "vitest";
import {
  CONFIG_KEY,
  countedDictionaries,
  DEFAULT_ORDER,
  emptyConfig,
  isEmptyConfig,
  makePresetDefault,
  marksDictionary,
  parseDictionaryConfig,
  removePreset,
  renamePreset,
  storedConfigValue,
  toFrontmatterValue,
  upsertPreset,
  type DictionaryConfig,
  type ReviewPreset,
} from "../src/model/dictionaryConfig";

function preset(overrides: Partial<ReviewPreset> = {}): ReviewPreset {
  return {
    name: "Forward",
    front: ["word"],
    back: ["translation"],
    pool: "due",
    order: DEFAULT_ORDER,
    record: true,
    extra: {},
    ...overrides,
  };
}

const EMPTY = { mute: false, presets: [], extra: {}, unreadable: [] };

describe("parseDictionaryConfig", () => {
  it("returns an empty config when the key is absent", () => {
    expect(parseDictionaryConfig({ level: "B2" })).toEqual(EMPTY);
  });

  it("tolerates frontmatter that is not an object", () => {
    for (const input of [null, undefined, "text", 42, []]) {
      expect(parseDictionaryConfig(input)).toEqual(EMPTY);
    }
  });

  it("tolerates a config block that is not an object", () => {
    expect(parseDictionaryConfig({ [CONFIG_KEY]: "nonsense" })).toEqual(EMPTY);
  });

  it("reads an empty block as absence", () => {
    // Obsidian's property editor writes null for a key added and left blank.
    expect(parseDictionaryConfig({ [CONFIG_KEY]: null })).toEqual(EMPTY);
  });

  it("reads mute and ignores a non-boolean value", () => {
    expect(parseDictionaryConfig({ [CONFIG_KEY]: { mute: true } }).mute).toBe(true);
    expect(parseDictionaryConfig({ [CONFIG_KEY]: { mute: "yes" } }).mute).toBe(false);
  });

  it("fills preset defaults for omitted fields", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: [{ name: "Forward", front: ["word"] }] },
    });
    expect(config.presets).toEqual([preset({ back: [] })]);
  });

  it("defaults record to false for an all-cards preset", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: [{ name: "Cram", front: ["word"], pool: "all" }] },
    });
    expect(config.presets[0]?.record).toBe(false);
  });

  it("keeps an explicit record over the pool default", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: [{ name: "Cram", front: ["word"], pool: "all", record: true }] },
    });
    expect(config.presets[0]?.record).toBe(true);
  });

  it("accepts a bare string as a one-column list", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: [{ name: "Reverse", front: "translation", back: "word" }] },
    });
    expect(config.presets[0]?.front).toEqual(["translation"]);
    expect(config.presets[0]?.back).toEqual(["word"]);
  });

  it("drops managed columns, blanks, duplicates and non-strings from column lists", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: {
        presets: [{ name: "Messy", front: ["word", " word ", "", "srs", "due", 7, "note"] }],
      },
    });
    expect(config.presets[0]?.front).toEqual(["word", "note"]);
  });

  it("does not model presets without a usable name, or duplicate names", () => {
    const unnamed = { front: ["word"] };
    const blank = { name: "  ", front: ["word"] };
    const duplicate = { name: "Forward", front: ["translation"] };
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: {
        presets: [unnamed, blank, "nonsense", { name: "Forward", front: ["word"] }, duplicate],
      },
    });
    expect(config.presets.map((p) => p.name)).toEqual(["Forward"]);
    expect(config.presets[0]?.front).toEqual(["word"]);
    // Kept verbatim rather than discarded, so a later write does not delete them.
    expect(config.unreadable).toEqual([unnamed, blank, "nonsense", duplicate]);
  });

  it("carries unmodeled keys of the block and of a preset", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: {
        retention: 0.85,
        presets: [{ name: "Forward", front: ["word"], note: "hand-written" }],
      },
    });
    expect(config.extra).toEqual({ retention: 0.85 });
    expect(config.presets[0]?.extra).toEqual({ note: "hand-written" });
  });

  it("models nothing from a presets value that is not a list, but keeps it", () => {
    const entry = { name: "Forward", front: ["word"] };
    const config = parseDictionaryConfig({ [CONFIG_KEY]: { presets: entry } });
    expect(config.presets).toEqual([]);
    // A mapping written where a list belongs is a common slip: keep it so an
    // unrelated write cannot delete the user's only preset.
    expect(config.unreadable).toEqual([entry]);
  });

  it("repairs a mapping-instead-of-list on the next write", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: { name: "Forward", front: ["word"] } },
    });
    const reparsed = parseDictionaryConfig({ [CONFIG_KEY]: toFrontmatterValue(config) });
    expect(reparsed.presets.map((p) => p.name)).toEqual(["Forward"]);
  });

  it("has nothing to keep for a null presets value", () => {
    expect(parseDictionaryConfig({ [CONFIG_KEY]: { presets: null } }).unreadable).toEqual([]);
  });

  it("falls back to defaults for unknown pool and order values", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: [{ name: "Odd", front: ["word"], pool: "some", order: "other" }] },
    });
    expect(config.presets[0]?.pool).toBe("due");
    expect(config.presets[0]?.order).toBe(DEFAULT_ORDER);
  });

  it("shuffles a preset that says nothing about order", () => {
    // Saving a field layout should not quietly pin the order to the file: a preset
    // with no `order` gets the same shuffle a dictionary without presets gets.
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: [{ name: "Forward", front: ["word"] }] },
    });
    expect(config.presets[0]?.order).toBe("shuffled");
  });

  it("honours an explicit file order", () => {
    const config = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: [{ name: "Forward", front: ["word"], order: "file" }] },
    });
    expect(config.presets[0]?.order).toBe("file");
  });
});

describe("toFrontmatterValue", () => {
  function config(overrides: Partial<DictionaryConfig> = {}): DictionaryConfig {
    return { mute: false, presets: [], extra: {}, unreadable: [], ...overrides };
  }

  it("returns null for an empty config so the key can be dropped", () => {
    expect(toFrontmatterValue(config())).toBeNull();
  });

  it("omits fields that parse back to the same defaults", () => {
    expect(toFrontmatterValue(config({ presets: [preset({ back: [] })] }))).toEqual({
      presets: [{ name: "Forward", front: ["word"] }],
    });
  });

  it("writes non-default fields", () => {
    const value = toFrontmatterValue(
      config({ mute: true, presets: [preset({ pool: "all", order: "file", record: true })] }),
    );
    expect(value).toEqual({
      mute: true,
      presets: [
        {
          name: "Forward",
          front: ["word"],
          back: ["translation"],
          pool: "all",
          order: "file",
          record: true,
        },
      ],
    });
  });

  it("writes unmodeled keys and unreadable entries back untouched", () => {
    const value = toFrontmatterValue(
      config({
        extra: { retention: 0.85 },
        presets: [preset({ extra: { note: "hand-written" } })],
        unreadable: [{ front: ["word"] }],
      }),
    );
    expect(value).toEqual({
      retention: 0.85,
      presets: [
        { note: "hand-written", name: "Forward", front: ["word"], back: ["translation"] },
        { front: ["word"] },
      ],
    });
  });

  it("never lets a carried key masquerade as a modeled one", () => {
    // `extra` is a public field, and modeled keys are omitted when they hold
    // their default — so a stray entry must not slip into the file as real data.
    const value = toFrontmatterValue(
      config({
        extra: { mute: true, presets: ["EVIL"] },
        presets: [preset({ back: [], extra: { back: ["EVIL"], pool: "all", name: "OVERRIDDEN" } })],
      }),
    );
    expect(value).toEqual({ presets: [{ name: "Forward", front: ["word"] }] });
  });

  it("carries keys that collide with Object.prototype members", () => {
    // A presence check via `in` would see these on the prototype chain and drop
    // them — in the one function whose whole job is to not lose user data.
    const value = toFrontmatterValue(
      config({
        extra: { toString: "hi", valueOf: 1 },
        presets: [preset({ extra: { constructor: "c", hasOwnProperty: "x" } })],
      }),
    );
    expect(value).toMatchObject({ toString: "hi", valueOf: 1 });
    expect((value?.["presets"] as Record<string, unknown>[])[0]).toMatchObject({
      constructor: "c",
      hasOwnProperty: "x",
    });
  });

  it("writes carried keys after the modeled ones, in their own order", () => {
    const value = toFrontmatterValue(
      config({ presets: [preset({ extra: { zzz: 1, note: "hand-written" } })] }),
    );
    const written = (value?.["presets"] as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(written)).toEqual(["name", "front", "back", "zzz", "note"]);
  });

  it("keeps the key alive for a block that only holds unmodeled data", () => {
    expect(toFrontmatterValue(config({ extra: { retention: 0.85 } }))).toEqual({
      retention: 0.85,
    });
  });

  it("round-trips every pool/record combination through a parse", () => {
    for (const pool of ["due", "all"] as const) {
      for (const record of [true, false]) {
        const original = config({ presets: [preset({ pool, record })] });
        const value = toFrontmatterValue(original);
        expect(parseDictionaryConfig({ [CONFIG_KEY]: value })).toEqual(original);
      }
    }
  });

  it("round-trips a config carrying hand-written data", () => {
    const original = config({
      mute: true,
      extra: { retention: 0.85 },
      presets: [
        preset({ extra: { note: "hand-written" } }),
        preset({ name: "Cram", pool: "all", order: "file", record: false }),
      ],
      unreadable: [{ front: ["word"] }],
    });
    expect(parseDictionaryConfig({ [CONFIG_KEY]: toFrontmatterValue(original) })).toEqual(original);
  });
});

describe("isEmptyConfig", () => {
  it("is true only when there is nothing at all to write", () => {
    expect(isEmptyConfig({ mute: false, presets: [], extra: {}, unreadable: [] })).toBe(true);
    expect(isEmptyConfig({ mute: true, presets: [], extra: {}, unreadable: [] })).toBe(false);
    expect(isEmptyConfig({ mute: false, presets: [preset()], extra: {}, unreadable: [] })).toBe(
      false,
    );
    expect(isEmptyConfig({ mute: false, presets: [], extra: { a: 1 }, unreadable: [] })).toBe(
      false,
    );
    expect(isEmptyConfig({ mute: false, presets: [], extra: {}, unreadable: [{}] })).toBe(false);
  });
});

describe("preset list helpers", () => {
  // Fresh objects per test: these helpers hand out references, so shared fixtures
  // would leak edits between cases.
  const forward = (): ReviewPreset => preset();
  const cram = (): ReviewPreset => preset({ name: "Cram", pool: "all" });

  function config(presets: ReviewPreset[] = []): DictionaryConfig {
    return { mute: false, presets, extra: {}, unreadable: [] };
  }

  it("appends a new preset and replaces one of the same name in place", () => {
    const target = config([forward()]);
    upsertPreset(target, cram());
    expect(target.presets.map((p) => p.name)).toEqual(["Forward", "Cram"]);
    upsertPreset(target, preset({ front: ["translation"] }));
    expect(target.presets.map((p) => p.name)).toEqual(["Forward", "Cram"]);
    expect(target.presets[0]?.front).toEqual(["translation"]);
  });

  it("removes by name and leaves a miss alone", () => {
    const target = config([forward(), cram()]);
    removePreset(target, "Forward");
    expect(target.presets.map((p) => p.name)).toEqual(["Cram"]);
    removePreset(target, "missing");
    expect(target.presets.map((p) => p.name)).toEqual(["Cram"]);
  });

  it("moves a preset to the front, leaving the rest in order", () => {
    const target = config([forward(), cram()]);
    makePresetDefault(target, "Cram");
    expect(target.presets.map((p) => p.name)).toEqual(["Cram", "Forward"]);
    makePresetDefault(target, "missing");
    expect(target.presets.map((p) => p.name)).toEqual(["Cram", "Forward"]);
  });

  it("renames without disturbing the order", () => {
    const target = config([forward(), cram()]);
    renamePreset(target, "Forward", "Reverse");
    expect(target.presets.map((p) => p.name)).toEqual(["Reverse", "Cram"]);
  });

  it("leaves the caller's preset object untouched when renaming", () => {
    const original = forward();
    renamePreset(config([original]), "Forward", "Reverse");
    expect(original.name).toBe("Forward");
  });

  it("absorbs a rename onto an existing name", () => {
    const target = config([forward(), cram()]);
    renamePreset(target, "Forward", "Cram");
    expect(target.presets.map((p) => p.name)).toEqual(["Cram"]);
    expect(target.presets[0]?.front).toEqual(["word"]);
  });

  it("ignores a rename to the same name", () => {
    const target = config([forward()]);
    renamePreset(target, "Forward", "Forward");
    expect(target.presets.map((p) => p.name)).toEqual(["Forward"]);
  });
});

describe("shadowed preset twins", () => {
  // An entry is unreadable only because a live preset holds its name. Removing or
  // renaming that preset must not let the twin come back as a real preset.
  function withTwin(): DictionaryConfig {
    return parseDictionaryConfig({
      [CONFIG_KEY]: {
        presets: [
          { name: "Forward", front: ["word"] },
          { name: "Forward", front: ["translation"], note: "shadowed twin" },
        ],
      },
    });
  }

  it("starts with the twin parked as unreadable", () => {
    const target = withTwin();
    expect(target.presets.map((p) => p.name)).toEqual(["Forward"]);
    expect(target.unreadable).toHaveLength(1);
  });

  it("does not resurrect the twin when the preset is deleted", () => {
    const target = withTwin();
    removePreset(target, "Forward");
    expect(toFrontmatterValue(target)).toBeNull();
    expect(parseDictionaryConfig({ [CONFIG_KEY]: toFrontmatterValue(target) }).presets).toEqual([]);
  });

  it("does not conjure a phantom preset when the preset is renamed", () => {
    const target = withTwin();
    renamePreset(target, "Forward", "Reverse");
    const reparsed = parseDictionaryConfig({ [CONFIG_KEY]: toFrontmatterValue(target) });
    expect(reparsed.presets.map((p) => p.name)).toEqual(["Reverse"]);
  });

  it("does not resurrect the twin when the preset is overwritten", () => {
    const target = withTwin();
    upsertPreset(target, preset({ front: ["transcription"] }));
    const reparsed = parseDictionaryConfig({ [CONFIG_KEY]: toFrontmatterValue(target) });
    expect(reparsed.presets.map((p) => p.name)).toEqual(["Forward"]);
    expect(reparsed.presets[0]?.front).toEqual(["transcription"]);
  });

  it("keeps entries that can never become readable", () => {
    const target = parseDictionaryConfig({
      [CONFIG_KEY]: { presets: [{ front: ["word"] }, "nonsense"] },
    });
    removePreset(target, "Forward");
    expect(target.unreadable).toEqual([{ front: ["word"] }, "nonsense"]);
  });
});

describe("marksDictionary", () => {
  it("accepts frontmatter carrying the key, whatever it holds", () => {
    expect(marksDictionary({ "fsrs-vocabulary": null })).toBe(true);
    expect(marksDictionary({ "fsrs-vocabulary": {} })).toBe(true);
    expect(marksDictionary({ "fsrs-vocabulary": { mute: true } })).toBe(true);
    // Unreadable config, but still a dictionary — the note says so.
    expect(marksDictionary({ "fsrs-vocabulary": "nonsense" })).toBe(true);
  });

  it("rejects frontmatter without the key", () => {
    expect(marksDictionary({ tags: ["fsrs-vocabulary"] })).toBe(false);
    expect(marksDictionary({})).toBe(false);
  });

  it("rejects a missing or non-mapping frontmatter", () => {
    expect(marksDictionary(null)).toBe(false);
    expect(marksDictionary(undefined)).toBe(false);
    expect(marksDictionary("fsrs-vocabulary")).toBe(false);
    expect(marksDictionary([])).toBe(false);
  });

  it("does not mistake an inherited key for the marker", () => {
    expect(marksDictionary({ toString: "x" })).toBe(false);
  });
});

describe("storedConfigValue", () => {
  it("writes the serialized config when there is something to write", () => {
    const config = emptyConfig();
    config.mute = true;
    expect(storedConfigValue(config, true)).toEqual({ mute: true });
  });

  it("keeps an existing key present but empty when the config empties out", () => {
    // Losing the key here would un-dictionary the note: unmuting it, or deleting
    // its last preset, would silently stop it being a dictionary at all.
    expect(storedConfigValue(emptyConfig(), true)).toEqual({});
  });

  it("keeps the emptied value a mapping, not a null a round-trip could drop", () => {
    expect(marksDictionary({ "fsrs-vocabulary": storedConfigValue(emptyConfig(), true) })).toBe(
      true,
    );
  });

  it("leaves a note without the key alone", () => {
    expect(storedConfigValue(emptyConfig(), false)).toBeUndefined();
  });
});

describe("countedDictionaries", () => {
  const muted = (item: { mute: boolean }): boolean => item.mute;
  const items = [{ mute: false }, { mute: true }, { mute: false }];

  it("drops muted dictionaries by default", () => {
    expect(countedDictionaries(items, muted, false)).toEqual([{ mute: false }, { mute: false }]);
  });

  it("keeps every dictionary when muted ones count", () => {
    expect(countedDictionaries(items, muted, true)).toEqual(items);
  });

  it("returns a copy, so a caller cannot mutate the source list", () => {
    expect(countedDictionaries(items, muted, true)).not.toBe(items);
  });
});
