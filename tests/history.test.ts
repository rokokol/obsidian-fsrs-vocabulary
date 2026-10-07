import { State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import {
  formatEntry,
  historyFileName,
  isHistoryFile,
  parseHistory,
  type ReviewLogEntry,
} from "../src/model/history";
import { ReviewHistory, type HistoryAdapter } from "../src/obsidian/history";

const entry = (c: string, t: number, r: ReviewLogEntry["r"] = 3, s = State.Review): ReviewLogEntry => ({
  c,
  t,
  r,
  s,
});

describe("history lines", () => {
  it("round-trips entries, one line each", () => {
    const entries = [entry("a1", 1000, 1, State.New), entry("b2", 2000, 4)];
    const text = entries.map(formatEntry).join("");
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(parseHistory(text)).toEqual(entries);
  });

  it("skips lines it cannot trust instead of failing the whole file", () => {
    // A file synced mid-append ends in half a line; a hand edit can leave anything.
    const text =
      formatEntry(entry("a1", 1000)) +
      "not json\n" +
      '{"c":"a1","t":2000,"r":5,"s":2}\n' +
      '{"c":"a1","t":"yesterday","r":3,"s":2}\n' +
      '{"c":"","t":3000,"r":3,"s":2}\n' +
      '{"c":"a1","t":4000,"r":3,"s":9}\n' +
      formatEntry(entry("a1", 5000)) +
      '{"c":"a1","t":6';
    expect(parseHistory(text)).toEqual([entry("a1", 1000), entry("a1", 5000)]);
  });
});

describe("history file names", () => {
  it("names the file after the platform and the device", () => {
    expect(historyFileName("desktop", "x7")).toBe("history-desktop-x7.jsonl");
    expect(historyFileName("mobile", "x7")).toBe("history-mobile-x7.jsonl");
  });

  it("recognises every device's file and a sync conflict copy of one", () => {
    expect(isHistoryFile("history-desktop-x7.jsonl")).toBe(true);
    expect(isHistoryFile("history-mobile-q1.jsonl")).toBe(true);
    expect(isHistoryFile("history-desktop-x7.sync-conflict-20261007-120000-ABCDEFG.jsonl")).toBe(
      true,
    );
    expect(isHistoryFile("data.json")).toBe(false);
    expect(isHistoryFile("main.js")).toBe(false);
    expect(isHistoryFile("history-desktop-x7.jsonl.tmp")).toBe(false);
  });
});

/** An in-memory folder with the slice of the adapter the history uses. */
function memoryAdapter(files: Record<string, string> = {}): HistoryAdapter & {
  files: Record<string, string>;
} {
  const store = { ...files };
  return {
    files: store,
    // A folder exists while it holds a file.
    exists: (path) =>
      Promise.resolve(path in store || Object.keys(store).some((key) => key.startsWith(`${path}/`))),
    read: (path) => {
      const text = store[path];
      return text === undefined ? Promise.reject(new Error(`no ${path}`)) : Promise.resolve(text);
    },
    write: (path, data) => {
      store[path] = data;
      return Promise.resolve();
    },
    append: (path, data) => {
      store[path] = (store[path] ?? "") + data;
      return Promise.resolve();
    },
    list: (dir) =>
      Promise.resolve({
        files: Object.keys(store).filter((path) => path.startsWith(`${dir}/`)),
        folders: [],
      }),
  };
}

describe("ReviewHistory", () => {
  const DIR = "config/plugins/fsrs-vocabulary";

  it("appends to this device's file only", async () => {
    const adapter = memoryAdapter({ [`${DIR}/history-mobile-p9.jsonl`]: formatEntry(entry("z", 1)) });
    const history = new ReviewHistory(adapter, DIR, "desktop", "d1");
    await history.append(entry("a1", 1000));
    await history.append(entry("a1", 2000));
    expect(parseHistory(adapter.files[`${DIR}/history-desktop-d1.jsonl`] ?? "")).toEqual([
      entry("a1", 1000),
      entry("a1", 2000),
    ]);
    expect(adapter.files[`${DIR}/history-mobile-p9.jsonl`]).toBe(formatEntry(entry("z", 1)));
  });

  it("keeps the order of appends fired without waiting", async () => {
    const adapter = memoryAdapter();
    const history = new ReviewHistory(adapter, DIR, "desktop", "d1");
    await Promise.all([1, 2, 3, 4].map((t) => history.append(entry("a1", t))));
    expect(parseHistory(adapter.files[`${DIR}/history-desktop-d1.jsonl`] ?? "").map((e) => e.t)).toEqual(
      [1, 2, 3, 4],
    );
  });

  it("reads every device's file, in time order, without duplicates", async () => {
    const shared = formatEntry(entry("a1", 1000));
    const adapter = memoryAdapter({
      [`${DIR}/history-desktop-d1.jsonl`]: shared + formatEntry(entry("a1", 3000)),
      [`${DIR}/history-mobile-p9.jsonl`]: formatEntry(entry("b2", 2000)),
      // A conflict copy repeats what its original holds, and may hold more.
      [`${DIR}/history-desktop-d1.sync-conflict-20261007-120000-ABC.jsonl`]:
        shared + formatEntry(entry("c3", 500)),
      [`${DIR}/data.json`]: "{}",
    });
    const history = new ReviewHistory(adapter, DIR, "desktop", "d1");
    const read = await history.readAll();
    expect(read.entries.map((e) => [e.c, e.t])).toEqual([
      ["c3", 500],
      ["a1", 1000],
      ["b2", 2000],
      ["a1", 3000],
    ]);
    expect(read.files).toBe(3);
  });

  it("reads nothing, without failing, before anything was logged", async () => {
    const history = new ReviewHistory(memoryAdapter(), DIR, "desktop", "d1");
    expect(await history.readAll()).toEqual({ entries: [], files: 0 });
  });
});
