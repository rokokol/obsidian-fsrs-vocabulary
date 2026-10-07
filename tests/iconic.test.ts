import type { App } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { iconicColor, parseIconicData, parseIconicEntry } from "../src/model/iconic";
import { forgetIconicIcons, iconicInstalled, readIconicIcons } from "../src/obsidian/iconic";

describe("parseIconicEntry", () => {
  it("reads a Lucide icon, stripping the prefix setIcon does not want", () => {
    expect(parseIconicEntry({ icon: "lucide-book-a" })).toEqual({
      lucide: "book-a",
      emoji: null,
      color: null,
    });
  });

  it("reads a bare icon id as an icon name", () => {
    // Iconic stores more than Lucide: an icon another plugin registered comes out
    // without the prefix (`excalidraw-icon`, `math-integral-x`, `arrowtab`). Treated
    // as text, the id itself was printed where the picture belongs.
    expect(parseIconicEntry({ icon: "math-integral-x" })).toEqual({
      lucide: "math-integral-x",
      emoji: null,
      color: null,
    });
    expect(parseIconicEntry({ icon: "arrowtab" })?.lucide).toBe("arrowtab");
  });

  it("reads an emoji icon as a glyph, not an icon name", () => {
    expect(parseIconicEntry({ icon: "📚" })).toEqual({ lucide: null, emoji: "📚", color: null });
  });

  it("does not mistake a name with capitals, spaces or punctuation for an icon id", () => {
    // `setIcon` would draw nothing for these, and drawing nothing is worse than
    // showing the glyph the user actually stored.
    expect(parseIconicEntry({ icon: "Book" })?.emoji).toBe("Book");
    expect(parseIconicEntry({ icon: "two words" })?.emoji).toBe("two words");
    expect(parseIconicEntry({ icon: "-leading-dash" })?.emoji).toBe("-leading-dash");
  });

  it("keeps a multi-codepoint emoji whole", () => {
    const icon = parseIconicEntry({ icon: "🧑‍🎓" });
    expect(icon?.emoji).toBe("🧑‍🎓");
  });

  it("carries a colour through", () => {
    expect(parseIconicEntry({ icon: "lucide-book", color: "red" })?.color).toBe("var(--color-red)");
  });

  it("returns null for an entry with no icon", () => {
    expect(parseIconicEntry({ color: "red" })).toBeNull();
    expect(parseIconicEntry({ icon: "" })).toBeNull();
    expect(parseIconicEntry({ icon: "   " })).toBeNull();
  });

  it("returns null for anything that is not an entry", () => {
    expect(parseIconicEntry(null)).toBeNull();
    expect(parseIconicEntry("lucide-book")).toBeNull();
    expect(parseIconicEntry(["lucide-book"])).toBeNull();
    expect(parseIconicEntry(undefined)).toBeNull();
  });

  it("ignores a non-string icon rather than rendering it", () => {
    expect(parseIconicEntry({ icon: 42 })).toBeNull();
  });

  it("does not read a bare `lucide-` as a Lucide icon, since no name is left", () => {
    // `setIcon("")` draws nothing, which would put a blank square in the icon grid
    // instead of letting the dictionary fall through to the text list — and the
    // prefix itself is not an emoji to print in its place.
    expect(parseIconicEntry({ icon: "lucide-" })).toBeNull();
  });

  it("does not read a prefixed name that is not an icon id, which draws nothing", () => {
    expect(parseIconicEntry({ icon: "lucide-Book A" })).toBeNull();
  });
});

describe("iconicColor", () => {
  it("maps Iconic's palette names onto theme variables", () => {
    expect(iconicColor("blue")).toBe("var(--color-blue)");
    expect(iconicColor("PURPLE")).toBe("var(--color-purple)");
  });

  it("maps gray onto the base shade Iconic uses, since the palette has no gray", () => {
    // `var(--color-gray)` is undefined in Obsidian, and an undefined variable makes
    // the whole declaration fall back to `inherit` — losing the colour entirely.
    expect(iconicColor("gray")).toBe("var(--color-base-70)");
  });

  it("passes an explicit colour through", () => {
    expect(iconicColor("#ff8800")).toBe("#ff8800");
    expect(iconicColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
  });

  it("has no opinion when there is no colour", () => {
    expect(iconicColor(undefined)).toBeNull();
    expect(iconicColor("")).toBeNull();
    expect(iconicColor(7)).toBeNull();
  });
});

describe("parseIconicData", () => {
  it("collects every readable file icon, keyed by path", () => {
    const icons = parseIconicData({
      fileIcons: {
        "Words.md": { icon: "lucide-book-a" },
        "Folder/Latin.md": { icon: "🏛️", color: "yellow" },
      },
      unrelated: 1,
    });
    expect([...icons.keys()]).toEqual(["Words.md", "Folder/Latin.md"]);
    expect(icons.get("Folder/Latin.md")).toEqual({
      lucide: null,
      emoji: "🏛️",
      color: "var(--color-yellow)",
    });
  });

  it("skips entries with nothing to draw", () => {
    const icons = parseIconicData({
      fileIcons: { "a.md": { color: "red" }, "b.md": { icon: "lucide-book" } },
    });
    expect([...icons.keys()]).toEqual(["b.md"]);
  });

  it("keeps folder entries out of nobody's way — they are just paths", () => {
    // Iconic stores folders in the same map; a folder path simply never matches a
    // dictionary file, so no filtering is needed here.
    const icons = parseIconicData({ fileIcons: { "00. Attachments": { icon: "lucide-boxes" } } });
    expect(icons.size).toBe(1);
  });

  it("returns an empty map for data it cannot read", () => {
    expect(parseIconicData(null).size).toBe(0);
    expect(parseIconicData("{}").size).toBe(0);
    expect(parseIconicData({}).size).toBe(0);
    expect(parseIconicData({ fileIcons: [] }).size).toBe(0);
    expect(parseIconicData({ fileIcons: null }).size).toBe(0);
  });
});

/**
 * `readIconicIcons` only type-imports Obsidian, so a fake `App` exercising the
 * adapter is enough — and the I/O is where the risk actually is.
 */
interface FakeStat {
  mtime: number;
}

/**
 * The vault's config folder in these tests. Not the usual name on purpose: a plugin
 * that assumed the usual one would look in the wrong place and fail every test here.
 */
const CONFIG_DIR = "test-config";

function fakeApp(
  files: Record<string, string>,
  stats: Record<string, FakeStat | null>,
  counters = { reads: 0, statCalls: 0 },
): { app: App; counters: typeof counters } {
  const app = {
    vault: {
      configDir: CONFIG_DIR,
      adapter: {
        stat: (path: string): Promise<FakeStat | null> => {
          counters.statCalls += 1;
          return Promise.resolve(stats[path] ?? null);
        },
        read: (path: string): Promise<string> => {
          counters.reads += 1;
          const body = files[path];
          if (body === undefined) return Promise.reject(new Error("ENOENT"));
          return Promise.resolve(body);
        },
      },
    },
  } as unknown as App;
  return { app, counters };
}

const ICONIC_PATH = `${CONFIG_DIR}/plugins/iconic/data.json`;
const MANIFEST_PATH = `${CONFIG_DIR}/plugins/iconic/manifest.json`;

describe("iconicInstalled", () => {
  it("sees Iconic by the manifest Obsidian wrote when installing it", async () => {
    const { app } = fakeApp({}, { [MANIFEST_PATH]: { mtime: 1 } });
    expect(await iconicInstalled(app)).toBe(true);
  });

  it("does not settle for the data file alone", async () => {
    // Iconic uninstalled leaves nothing behind, but a vault restored from a partial
    // backup could; the manifest is the one file Obsidian itself maintains.
    const { app } = fakeApp({}, { [ICONIC_PATH]: { mtime: 1 } });
    expect(await iconicInstalled(app)).toBe(false);
  });

  it("says no in a vault without Iconic", async () => {
    const { app } = fakeApp({}, {});
    expect(await iconicInstalled(app)).toBe(false);
  });

  it("honours a non-default config folder", async () => {
    const { app } = fakeApp({}, { "myconfig/plugins/iconic/manifest.json": { mtime: 1 } });
    (app.vault as unknown as { configDir: string }).configDir = "myconfig";
    expect(await iconicInstalled(app)).toBe(true);
  });

  it("says no when the adapter throws", async () => {
    const app = {
      vault: {
        configDir: CONFIG_DIR,
        adapter: {
          stat: (): Promise<never> => Promise.reject(new Error("EACCES")),
        },
      },
    } as unknown as App;
    expect(await iconicInstalled(app)).toBe(false);
  });
});

describe("readIconicIcons", () => {
  beforeEach(() => {
    forgetIconicIcons();
  });

  it("reads the icons Iconic stored", async () => {
    const { app } = fakeApp(
      { [ICONIC_PATH]: JSON.stringify({ fileIcons: { "Words.md": { icon: "lucide-book-a" } } }) },
      { [ICONIC_PATH]: { mtime: 1 } },
    );
    const icons = await readIconicIcons(app);
    expect(icons.get("Words.md")?.lucide).toBe("book-a");
  });

  it("returns nothing when Iconic is not installed", async () => {
    const { app, counters } = fakeApp({}, {});
    expect((await readIconicIcons(app)).size).toBe(0);
    expect(counters.reads).toBe(0);
  });

  it("survives a data file that is not JSON", async () => {
    const { app } = fakeApp({ [ICONIC_PATH]: "{ not json" }, { [ICONIC_PATH]: { mtime: 1 } });
    expect((await readIconicIcons(app)).size).toBe(0);
  });

  it("survives a read that throws", async () => {
    // `stat` says the file is there, `read` disagrees — a deletion mid-flight.
    const { app } = fakeApp({}, { [ICONIC_PATH]: { mtime: 1 } });
    expect((await readIconicIcons(app)).size).toBe(0);
  });

  it("does not re-parse an unchanged file", async () => {
    const { app, counters } = fakeApp(
      { [ICONIC_PATH]: JSON.stringify({ fileIcons: { "a.md": { icon: "📚" } } }) },
      { [ICONIC_PATH]: { mtime: 7 } },
    );
    await readIconicIcons(app);
    await readIconicIcons(app);
    expect(counters.reads).toBe(1);
    expect(counters.statCalls).toBe(2);
  });

  it("picks up a change to the file", async () => {
    const stats: Record<string, FakeStat | null> = { [ICONIC_PATH]: { mtime: 1 } };
    const files: Record<string, string> = {
      [ICONIC_PATH]: JSON.stringify({ fileIcons: { "a.md": { icon: "📚" } } }),
    };
    const { app } = fakeApp(files, stats);
    expect((await readIconicIcons(app)).get("a.md")?.emoji).toBe("📚");
    files[ICONIC_PATH] = JSON.stringify({ fileIcons: { "a.md": { icon: "🎓" } } });
    stats[ICONIC_PATH] = { mtime: 2 };
    expect((await readIconicIcons(app)).get("a.md")?.emoji).toBe("🎓");
  });

  it("honours a non-default config folder", async () => {
    const { app } = fakeApp(
      {
        "myconfig/plugins/iconic/data.json": JSON.stringify({
          fileIcons: { "a.md": { icon: "lucide-book" } },
        }),
      },
      { "myconfig/plugins/iconic/data.json": { mtime: 1 } },
    );
    (app.vault as unknown as { configDir: string }).configDir = "myconfig";
    expect((await readIconicIcons(app)).size).toBe(1);
  });

  it("does not serve one vault's icons to another", async () => {
    // Two windows, two config folders, one module. Matching mtimes are ordinary —
    // both files could have been written by the same sync — so the cache has to
    // compare the path too.
    const { app: first } = fakeApp(
      { [ICONIC_PATH]: JSON.stringify({ fileIcons: { "a.md": { icon: "📚" } } }) },
      { [ICONIC_PATH]: { mtime: 1 } },
    );
    const { app: second } = fakeApp(
      {
        "other/plugins/iconic/data.json": JSON.stringify({ fileIcons: { "a.md": { icon: "🎓" } } }),
      },
      { "other/plugins/iconic/data.json": { mtime: 1 } },
    );
    (second.vault as unknown as { configDir: string }).configDir = "other";
    expect((await readIconicIcons(first)).get("a.md")?.emoji).toBe("📚");
    expect((await readIconicIcons(second)).get("a.md")?.emoji).toBe("🎓");
  });
});
