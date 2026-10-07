import { TFile, type App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DueTracker } from "../src/review/dueTracker";

/**
 * `DueTracker` only type-imports Obsidian, so a fake `App` with the one method it
 * calls is enough. What is worth testing here is the bookkeeping: that a burst of
 * events costs one pass, that counting reads no files, and that nothing keeps
 * running after dispose.
 */
const file = (path: string): TFile => Object.assign(new TFile(), { path });

interface Harness {
  tracker: DueTracker;
  /** Paths handed to the reader, in order, one entry per read. */
  reads: string[];
  changes: () => number;
  /** Timestamps the reader answers with, or null for "does not count". */
  due: Map<string, number[] | null>;
  /** Paths the fake vault still has. */
  present: Set<string>;
}

function harness(paths: string[] = ["a.md"]): Harness {
  const due = new Map<string, number[] | null>();
  const present = new Set(paths);
  const reads: string[] = [];
  let changes = 0;
  const app = {
    vault: {
      getFileByPath: (path: string): TFile | null => (present.has(path) ? file(path) : null),
    },
  } as unknown as App;
  const tracker = new DueTracker(
    app,
    () => [...present].map(file),
    () => {
      changes += 1;
    },
    (target: TFile) => {
      reads.push(target.path);
      return Promise.resolve(due.get(target.path) ?? null);
    },
  );
  return { tracker, reads, changes: () => changes, due, present };
}

/** Let the coalescing timer fire and the pass it starts finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2000);
}

const HOUR = 60 * 60 * 1000;

describe("DueTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
    // The tracker schedules through `window`, as an Obsidian plugin does; these tests
    // run in Node, where the timers are plain globals. They are taken after the fake
    // clock is installed above, so `window` holds the fake ones
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("counts nothing, and is not ready, before its first pass", () => {
    const { tracker } = harness();
    expect(tracker.ready).toBe(false);
    expect(tracker.count()).toBe(0);
  });

  it("counts the timestamps that have come due", async () => {
    const h = harness();
    const now = Date.now();
    h.due.set("a.md", [now - HOUR, now, now + HOUR]);
    h.tracker.invalidateAll();
    await settle();
    expect(h.tracker.ready).toBe(true);
    expect(h.tracker.count()).toBe(2);
  });

  it("recounts from the cache as time passes, without reading anything again", async () => {
    // The status-bar tick: a card falls due purely because the clock moved, so the
    // count has to change with no file touched.
    const h = harness();
    const now = Date.now();
    h.due.set("a.md", [now + HOUR]);
    h.tracker.invalidateAll();
    await settle();
    expect(h.tracker.count()).toBe(0);
    expect(h.tracker.count(new Date(now + 2 * HOUR))).toBe(1);
    expect(h.reads).toEqual(["a.md"]);
  });

  it("collapses a burst of invalidations into one pass", async () => {
    // A review session writes once per graded card, and every edit fires both a
    // vault and a metadata event.
    const h = harness();
    h.due.set("a.md", [Date.now()]);
    for (let i = 0; i < 10; i++) h.tracker.invalidate("a.md");
    await settle();
    expect(h.reads).toEqual(["a.md"]);
  });

  it("comes back for a write that landed mid-pass", async () => {
    const h = harness();
    h.due.set("a.md", [Date.now()]);
    h.tracker.invalidate("a.md");
    await settle();
    h.tracker.invalidate("a.md");
    await settle();
    expect(h.reads).toEqual(["a.md", "a.md"]);
  });

  it("drops a dictionary the reader no longer counts", async () => {
    const h = harness();
    h.due.set("a.md", [Date.now(), Date.now()]);
    h.tracker.invalidateAll();
    await settle();
    expect(h.tracker.count()).toBe(2);
    // Muted, or its words table removed: the reader answers null.
    h.due.set("a.md", null);
    h.tracker.invalidate("a.md");
    await settle();
    expect(h.tracker.count()).toBe(0);
  });

  it("keeps the rest of a pass going when one dictionary throws", async () => {
    const h = harness(["a.md", "b.md"]);
    h.due.set("b.md", [Date.now()]);
    const tracker = new DueTracker(
      { vault: { getFileByPath: (path: string) => file(path) } } as unknown as App,
      () => [file("a.md"), file("b.md")],
      () => undefined,
      (target: TFile) => {
        if (target.path === "a.md") return Promise.reject(new Error("unreadable"));
        return Promise.resolve(h.due.get(target.path) ?? null);
      },
    );
    tracker.invalidateAll();
    await settle();
    expect(tracker.count()).toBe(1);
    tracker.dispose();
  });

  it("forgets a deleted dictionary, and reports the change only if it counted", async () => {
    const h = harness();
    h.due.set("a.md", [Date.now()]);
    h.tracker.invalidateAll();
    await settle();
    const before = h.changes();
    h.tracker.forget("never-counted.md");
    expect(h.changes()).toBe(before);
    h.tracker.forget("a.md");
    expect(h.tracker.count()).toBe(0);
    expect(h.changes()).toBe(before + 1);
  });

  it("prunes an entry whose file went away without an event", async () => {
    const h = harness();
    h.due.set("a.md", [Date.now()]);
    h.tracker.invalidateAll();
    await settle();
    h.present.delete("a.md");
    h.tracker.prune();
    expect(h.tracker.count()).toBe(0);
  });

  it("does nothing after dispose", async () => {
    const h = harness();
    h.due.set("a.md", [Date.now()]);
    h.tracker.invalidate("a.md");
    h.tracker.dispose();
    await settle();
    // Neither the pending pass nor a later invalidation may reach the file or the
    // callback: the plugin is gone, and painting into its chrome would resurrect it.
    expect(h.reads).toEqual([]);
    h.tracker.invalidate("a.md");
    await settle();
    expect(h.reads).toEqual([]);
    expect(h.changes()).toBe(0);
  });
});
