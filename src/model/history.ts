/**
 * The review log: one line of JSON per graded card, the raw material the
 * personalised weights are fitted from.
 *
 * Each device appends to a file of its own. A file sync such as Syncthing moves
 * whole files, so one log written on two devices would end in a conflict copy and a
 * lost half; a file per device has a single writer and never conflicts. Readers take
 * every device's file together, and tolerate a conflict copy if one appears anyway.
 */

import { State } from "ts-fsrs";

/** One graded review. Short keys, because the file only ever grows. */
export interface ReviewLogEntry {
  /** Card id, from the card's `srs` cell. */
  c: string;
  /** When it was graded, in epoch milliseconds. */
  t: number;
  /** The grade: 1 again, 2 hard, 3 good, 4 easy. */
  r: 1 | 2 | 3 | 4;
  /**
   * The card's state before this grade. A card whose first logged review is not
   * in the new state was reviewed before logging began, so its history here is
   * incomplete.
   */
  s: State;
}

/** Where the log comes from, as part of its file name. */
export type DevicePlatform = "desktop" | "mobile";

/** One entry as a line of the log, newline included. */
export function formatEntry(entry: ReviewLogEntry): string {
  return `${JSON.stringify({ c: entry.c, t: entry.t, r: entry.r, s: entry.s })}\n`;
}

const GRADES = new Set([1, 2, 3, 4]);
const STATES = new Set<number>([State.New, State.Learning, State.Review, State.Relearning]);

function parseLine(line: string): ReviewLogEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { c, t, r, s } = raw as Record<string, unknown>;
  if (typeof c !== "string" || c === "") return null;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (typeof r !== "number" || !GRADES.has(r)) return null;
  if (typeof s !== "number" || !STATES.has(s)) return null;
  return { c, t, r: r as ReviewLogEntry["r"], s };
}

/**
 * Every entry of a log file that can be read. A line that cannot is skipped rather
 * than failing the file: a sync can deliver a file mid-append, ending in half a
 * line, and one bad line must not cost the rest of the history.
 */
export function parseHistory(text: string): ReviewLogEntry[] {
  const entries: ReviewLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The log file a device writes. */
export function historyFileName(platform: DevicePlatform, deviceId: string): string {
  return `history-${platform}-${deviceId}.jsonl`;
}

/**
 * Whether a file name is a review log: a device's own file, or a sync conflict
 * copy of one, which keeps the `.jsonl` ending and may hold entries the original
 * lost.
 */
export function isHistoryFile(name: string): boolean {
  return /^history-(desktop|mobile)-[a-z0-9]+(\.[^/]*)?\.jsonl$/.test(name);
}

/** The same review read from two files is one review. */
export function entryKey(entry: ReviewLogEntry): string {
  return `${entry.c}|${entry.t.toString()}|${entry.r.toString()}`;
}
