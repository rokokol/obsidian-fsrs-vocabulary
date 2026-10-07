import { default_w } from "ts-fsrs";
import { contentColumns, isManagedColumn } from "./model/dictionary";

/** Columns a fresh dictionary starts with — the first is the card front / key. */
export const DEFAULT_COLUMNS = ["word", "transcription", "translation"];

/**
 * The "front" column of a dictionary: the first non-managed header (the key), or
 * "" when the table carries nothing but managed columns. Callers treat "" as
 * "this is not a usable words table".
 */
export function frontColumnFor(headers: string[]): string {
  return contentColumns(headers)[0] ?? "";
}

/** Split a user-typed list (commas/newlines) into trimmed, deduped keys. */
function parseKeyList(input: string, reject?: (key: string) => boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\n,]/)) {
    const key = raw.trim();
    if (key === "" || seen.has(key) || reject?.(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Parse a user-typed column list (commas/newlines) into clean content columns. */
export function sanitizeColumns(input: string): string[] {
  return parseKeyList(input, isManagedColumn);
}

/** How a dictionary note opens by default. */
export type DefaultView = "dictionary" | "markdown";

/** Ordering of words in the interactive view. */
export type SortMode = "manual" | "front-asc" | "front-desc" | "due-asc" | "shuffled";

/** Human labels for each sort mode, in menu order. */
export const SORT_LABELS: Record<SortMode, string> = {
  manual: "Manual (file order)",
  "front-asc": "Word A→Z",
  "front-desc": "Word Z→A",
  "due-asc": "Due first",
  shuffled: "Random",
};

export interface FsrsVocabularySettings {
  /** Content columns a new dictionary is created with (first = card front/key). */
  newDictionaryColumns: string[];
  /** Target retention for FSRS scheduling (0..1). */
  fsrsRetention: number;
  /**
   * FSRS weights fitted to this user's own reviews; null schedules with the
   * defaults. One set for every dictionary.
   */
  fsrsWeights: number[] | null;
  /** Whether review pulls due cards from all dictionaries or just the active note. */
  reviewScope: "note" | "vault";
  /** Whether dictionary notes auto-open in the interactive view or as markdown. */
  defaultView: DefaultView;
  /** Default word ordering in the interactive view. */
  defaultSort: SortMode;
  /**
   * Frontmatter keys to render in the dictionary "properties" block, in order.
   * Empty = show every non-system property (the original behavior).
   */
  properties: string[];
  /**
   * Whether the answer joins the question on screen instead of replacing it.
   * On by default: a card usually reads better whole.
   */
  keepQuestionOnReveal: boolean;
  /** Whether muted dictionaries count toward stats blocks and vault sessions. */
  statsIncludeMuted: boolean;
  /**
   * Whether the tiles view reads icons from the Iconic plugin. Off until asked
   * for: it reads another plugin's private data file, which is not something to
   * start doing on the user's behalf. The setting is only shown when Iconic is
   * installed — with it absent there is nothing to read and the switch would mean
   * nothing.
   */
  iconicIntegration: boolean;
  /** Master switch for every reminder below. */
  remindersEnabled: boolean;
  /** Notice on start-up when cards are waiting. */
  remindOnStartup: boolean;
  /** Repeat the notice every N minutes; 0 = only on start-up. */
  remindEveryMinutes: number;
  /** Keep a due counter in the status bar. */
  statusBarCounter: boolean;
}

/** Longest repeat interval the settings field accepts — a week, in minutes. */
export const MAX_REMIND_MINUTES = 7 * 24 * 60;

/**
 * A reminder interval that is safe to hand to `setInterval`. Nonsense — a
 * negative, a `NaN`, a value out of a hand-edited settings file — becomes zero,
 * which means "start-up only". A negative would otherwise be clamped to no delay
 * by the browser and fire a notice on every tick, forever.
 */
export function clampRemindMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), MAX_REMIND_MINUTES);
}

/**
 * Read a user-typed reminder interval. A cleared field is a deliberate zero, but
 * text that is not a number at all keeps the current value: retyping an interval
 * and fumbling it should not silently switch the reminder off. The input must be
 * a plain text field for this to be reachable — `type="number"` reports
 * unparseable content as the empty string, which is indistinguishable from
 * clearing it on purpose.
 */
export function parseRemindMinutes(input: string, current: number): number {
  const text = input.trim();
  if (text === "") return 0;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return current;
  return clampRemindMinutes(value);
}

export const DEFAULT_SETTINGS: FsrsVocabularySettings = {
  newDictionaryColumns: [...DEFAULT_COLUMNS],
  fsrsRetention: 0.9,
  fsrsWeights: null,
  reviewScope: "note",
  defaultView: "dictionary",
  defaultSort: "manual",
  properties: [], // empty = render every property
  keepQuestionOnReveal: true,
  statsIncludeMuted: false,
  iconicIntegration: false,
  remindersEnabled: true,
  remindOnStartup: true,
  remindEveryMinutes: 0,
  statusBarCounter: true,
};

/** Setting names this version no longer writes, kept only to be read once. */
interface LegacySettings {
  /** Became `remindEveryMinutes`; hours were too coarse to be useful. */
  remindEveryHours?: number;
}

/**
 * Bring a stored settings object up to the current shape. Without this a vault
 * that still holds `remindEveryHours` would fall back to the default of zero and
 * quietly stop repeating its reminders.
 *
 * The interval is clamped whichever key it arrived under: `data.json` is a plain
 * file a user may well have edited, and it feeds a timer.
 */
export function migrateSettings(
  stored: Partial<FsrsVocabularySettings> & LegacySettings,
): Partial<FsrsVocabularySettings> {
  const { remindEveryHours, ...rest } = stored;
  const weights =
    rest.fsrsWeights === undefined ? {} : { fsrsWeights: sanitizeWeights(rest.fsrsWeights) };
  if (rest.remindEveryMinutes !== undefined) {
    return {
      ...rest,
      ...weights,
      remindEveryMinutes: clampRemindMinutes(rest.remindEveryMinutes),
    };
  }
  if (remindEveryHours === undefined) return { ...rest, ...weights };
  return {
    ...rest,
    ...weights,
    remindEveryMinutes: clampRemindMinutes(remindEveryHours * 60),
  };
}

/**
 * Stored weights the scheduler can use, or null for the defaults. A set of another
 * length belongs to another FSRS version, and the scheduler would quietly convert or
 * reject it; anything not a finite number came from a hand edit.
 */
export function sanitizeWeights(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== default_w.length) return null;
  const weights: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    weights.push(item);
  }
  return weights;
}

/** Parse a user-typed list (commas/newlines) into a clean, deduped key list. */
export function sanitizePropertyKeys(input: string): string[] {
  return parseKeyList(input);
}

/**
 * Pick the frontmatter entries to display. `allow` is the configured order;
 * empty means "show all".
 */
export function selectProperties(
  entries: [string, unknown][],
  allow: string[],
): [string, unknown][] {
  if (allow.length === 0) return entries;
  const byKey = new Map<string, unknown>(entries);
  const out: [string, unknown][] = [];
  for (const key of allow) {
    if (byKey.has(key)) out.push([key, byKey.get(key)]);
  }
  return out;
}
