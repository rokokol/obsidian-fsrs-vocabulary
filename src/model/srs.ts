import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs";
import { isRandomId, randomId } from "../util";

/** The four review grades exposed in the UI. */
export type ReviewRating = "again" | "hard" | "good" | "easy";

export const REVIEW_RATINGS: readonly ReviewRating[] = ["again", "hard", "good", "easy"];

const GRADE: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

/** The FSRS grade of a rating, as the review log stores it: 1 again … 4 easy. */
export function gradeOf(rating: ReviewRating): Grade {
  return GRADE[rating];
}

/** Compact on-disk shape stored in the hidden `srs` column (JSON, no pipes). */
interface StoredSrs {
  s: number; // state (0..3)
  r: number; // reps
  l: number; // lapses
  S: number; // stability
  D: number; // difficulty
  c: number; // scheduled_days
  d: string; // due (ISO)
  t?: string; // last_review (ISO)
  p?: number; // learning_steps; absent = 0, the first step
  i: string; // card id, see `newCardId`
}

const round = (n: number): number => Math.round(n * 10000) / 10000;

/** A brand-new, never-reviewed card. */
export function newCard(now: Date = new Date()): Card {
  return createEmptyCard(now);
}

/**
 * A fresh card id.
 *
 * The id ties a card's logged reviews together, so it has to survive everything
 * that can happen to a row — the note renamed or moved, the word edited, rows
 * reordered. Only the `srs` cell itself travels with the card through all of
 * those, which is why the id lives there and not in a path or a row key.
 */
export function newCardId(): string {
  return randomId();
}

/** The id stored in an `srs` cell, or null when the cell has none worth trusting. */
export function cardIdFromCell(cell: string): string | null {
  const raw = parseCell(cell);
  const id = raw?.["i"];
  return isRandomId(id) ? id : null;
}

/** Serialize a card and its id into the compact `srs` cell value. */
export function encodeCard(card: Card, id: string): string {
  const stored: StoredSrs = {
    i: id,
    s: card.state,
    r: card.reps,
    l: card.lapses,
    S: round(card.stability),
    D: round(card.difficulty),
    c: card.scheduled_days,
    d: card.due.toISOString(),
    ...(card.last_review ? { t: card.last_review.toISOString() } : {}),
    ...(card.learning_steps > 0 ? { p: card.learning_steps } : {}),
  };
  return JSON.stringify(stored);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The JSON object in an `srs` cell, or null for a blank or malformed one. */
function parseCell(cell: string): Record<string, unknown> | null {
  const trimmed = cell.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
}

function asIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse a stored `srs` cell back into a card. Returns null when the cell is
 * empty or malformed — callers treat that as a fresh card.
 */
export function decodeCard(cell: string): Card | null {
  const o = parseCell(cell);
  if (!o) return null;

  const s = asNumber(o["s"]);
  const r = asNumber(o["r"]);
  const l = asNumber(o["l"]);
  const S = asNumber(o["S"]);
  const D = asNumber(o["D"]);
  const c = asNumber(o["c"]);
  const due = asIsoDate(o["d"]);
  if (s === null || r === null || l === null || S === null || D === null) return null;
  if (c === null || due === null) return null;

  const last = asIsoDate(o["t"]);
  // Spread over an empty card for the fields the cell does not carry. The one that
  // matters is `elapsed_days`: the scheduler recomputes it from `last_review` on
  // every grade, and older cells that stored it as `e` are read without it.
  const card: Card = {
    ...createEmptyCard(due),
    state: s,
    reps: r,
    lapses: l,
    stability: S,
    difficulty: D,
    scheduled_days: c,
    learning_steps: asNumber(o["p"]) ?? 0,
    due,
    ...(last ? { last_review: last } : {}),
  };
  return card;
}

/** Decode the cell, falling back to a fresh card for new/blank rows. */
export function cardFromCell(cell: string, now: Date = new Date()): Card {
  return decodeCard(cell) ?? newCard(now);
}

function scheduler(retention: number): ReturnType<typeof fsrs> {
  return fsrs(generatorParameters({ request_retention: retention }));
}

/** Apply a grade and return the next card state. */
export function review(
  card: Card,
  rating: ReviewRating,
  retention: number,
  now: Date = new Date(),
): Card {
  return scheduler(retention).next(card, now, GRADE[rating]).card;
}

/** Preview the next due date for each rating (for button hints). */
export function previewDueDates(
  card: Card,
  retention: number,
  now: Date = new Date(),
): Record<ReviewRating, Date> {
  const f = scheduler(retention);
  return Object.fromEntries(
    REVIEW_RATINGS.map((rating) => [rating, f.next(card, now, GRADE[rating]).card.due]),
  ) as Record<ReviewRating, Date>;
}

/** A day, in milliseconds — the unit FSRS intervals come back in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The same card rescheduled for a different target retention, or null when there is
 * nothing to move.
 *
 * Retention decides how long an interval FSRS is willing to give a memory of a known
 * stability, and it is applied when a card is graded — so changing the setting leaves
 * every existing `due` where it was, computed under the old target. This recomputes
 * one from the stability already stored: the memory model is untouched, only the
 * interval derived from it.
 *
 * Only a card in the review state is touched. A new card is due now by definition,
 * and learning and relearning steps are fixed minutes that retention has no say in;
 * moving those would be inventing a schedule rather than restating one.
 */
export function rescheduleCard(card: Card, retention: number, now: Date = new Date()): Card | null {
  if (card.state !== State.Review || !card.last_review) return null;
  const elapsed = Math.max(0, (now.getTime() - card.last_review.getTime()) / DAY_MS);
  // `elapsed` only reaches the interval through FSRS's fuzz, which `scheduler` leaves
  // at its default of off — so the same card gives the same answer today and next
  // month, and a card that did not move is skipped below. Turning fuzz on would make
  // that skip stop firing and this command rewrite every card, every run.
  const days = scheduler(retention).next_interval(card.stability, Math.round(elapsed));
  if (days === card.scheduled_days) return null;
  return {
    ...card,
    scheduled_days: days,
    due: new Date(card.last_review.getTime() + days * DAY_MS),
  };
}

/** Whether the card is due for review at `now`. */
export function isDue(card: Card, now: Date = new Date()): boolean {
  return card.due.getTime() <= now.getTime();
}

/** Readable YYYY-MM-DD for the mirrored `due` column. */
export function dueDateString(card: Card): string {
  return card.due.toISOString().slice(0, 10);
}
