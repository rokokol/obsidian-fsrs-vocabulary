import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { CONFIG_KEY } from "../src/model/dictionaryConfig";
import { DictionaryCache } from "../src/obsidian/cache";

/**
 * A vault of markdown notes whose frontmatter can be withheld, which is the state
 * that matters here: on a cold start Obsidian draws the workspace before it has
 * read any frontmatter, so detection legitimately answers "not a dictionary" for
 * every note in the vault.
 */
function fakeApp(notes: Record<string, Record<string, unknown> | null>): App {
  const files = Object.keys(notes).map((path) => {
    const file = new TFile();
    file.path = path;
    return file;
  });
  return {
    vault: {
      getMarkdownFiles: (): TFile[] => files,
      getAbstractFileByPath: (path: string): TFile | null =>
        files.find((file) => file.path === path) ?? null,
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const fm = notes[file.path];
        return fm ? { frontmatter: fm } : null;
      },
    },
  } as unknown as App;
}

/** Frontmatter that marks a note as a dictionary. */
const DICTIONARY = { [CONFIG_KEY]: null };

describe("DictionaryCache.rebuild", () => {
  it("finds the notes carrying the property", () => {
    const cache = new DictionaryCache(fakeApp({ "Words.md": DICTIONARY, "Diary.md": {} }));
    cache.rebuild();
    expect(cache.has("Words.md")).toBe(true);
    expect(cache.has("Diary.md")).toBe(false);
  });

  it("reports a change when it finds dictionaries the empty index did not have", () => {
    // The cold-start case: the first pass sees no frontmatter at all and finds
    // nothing, and the pass after `resolved` has to say that the answer moved —
    // that return is what repaints the views and reseeds the due count.
    const notes: Record<string, Record<string, unknown> | null> = { "Words.md": null };
    const cache = new DictionaryCache(fakeApp(notes));
    expect(cache.rebuild()).toBe(false);
    expect(cache.files()).toHaveLength(0);

    notes["Words.md"] = DICTIONARY;
    expect(cache.rebuild()).toBe(true);
    expect(cache.has("Words.md")).toBe(true);
  });

  it("reports no change when a rescan finds the same dictionaries", () => {
    // `resolved` fires on every later batch of edits too, and a repaint on each
    // one would interrupt whatever the user is doing in a dictionary view.
    const cache = new DictionaryCache(fakeApp({ "Words.md": DICTIONARY }));
    expect(cache.rebuild()).toBe(true);
    expect(cache.rebuild()).toBe(false);
  });

  it("reports a change when a dictionary stops being one", () => {
    const notes: Record<string, Record<string, unknown> | null> = { "Words.md": DICTIONARY };
    const cache = new DictionaryCache(fakeApp(notes));
    expect(cache.rebuild()).toBe(true);
    notes["Words.md"] = {};
    expect(cache.rebuild()).toBe(true);
    expect(cache.has("Words.md")).toBe(false);
  });

  it("notices a swap that leaves the count alone", () => {
    // Same size, different paths: comparing lengths alone would call this unchanged
    // and leave the shelf showing a dictionary that is no longer one.
    const notes: Record<string, Record<string, unknown> | null> = {
      "Words.md": DICTIONARY,
      "Verbs.md": {},
    };
    const cache = new DictionaryCache(fakeApp(notes));
    expect(cache.rebuild()).toBe(true);
    notes["Words.md"] = {};
    notes["Verbs.md"] = DICTIONARY;
    expect(cache.rebuild()).toBe(true);
    expect(cache.has("Words.md")).toBe(false);
    expect(cache.has("Verbs.md")).toBe(true);
  });

  it("drops a dictionary whose note has left the vault", () => {
    const notes: Record<string, Record<string, unknown> | null> = { "Words.md": DICTIONARY };
    const cache = new DictionaryCache(fakeApp(notes));
    expect(cache.rebuild()).toBe(true);
    delete notes["Words.md"];
    expect(cache.rebuild()).toBe(true);
    expect(cache.has("Words.md")).toBe(false);
    expect(cache.files()).toHaveLength(0);
  });

  it("reports no change when the per-file handler already added the path", () => {
    // The trap this guard walked into: `update` maintains the very set `rebuild`
    // diffs against, so a startup whose `changed` events landed first leaves the
    // rescan finding its own work and reporting nothing new — while every view on
    // screen still shows the empty vault it drew at layout time. Hence the plugin
    // runs its first believable pass unconditionally rather than on this answer.
    const notes: Record<string, Record<string, unknown> | null> = { "Words.md": DICTIONARY };
    const cache = new DictionaryCache(fakeApp(notes));
    const file = new TFile();
    file.path = "Words.md";
    cache.update(file);
    expect(cache.rebuild()).toBe(false);
    expect(cache.has("Words.md")).toBe(true);
  });
});
