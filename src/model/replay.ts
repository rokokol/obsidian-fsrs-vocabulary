/**
 * Recomputing a card's memory state from its review log under other weights.
 *
 * The `srs` cell holds the state the card's grades led to under the weights in use
 * when they were given. When the weights change, the same grades lead to a different
 * stability, and only the log still has the grades to replay.
 */

import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  State,
  type Card,
  type FSRSState,
} from "ts-fsrs";
import type { ReviewLogEntry } from "./history";

/** The log grouped by card id, each card's entries oldest first. */
export function replayIndex(entries: readonly ReviewLogEntry[]): Map<string, ReviewLogEntry[]> {
  const index = new Map<string, ReviewLogEntry[]>();
  for (const entry of entries) {
    const list = index.get(entry.c);
    if (list) list.push(entry);
    else index.set(entry.c, [entry]);
  }
  for (const list of index.values()) list.sort((a, b) => a.t - b.t);
  return index;
}

/**
 * The memory state `log` leads to under `weights` (null for the defaults), or null
 * when the log does not hold the card's whole history: it must start at the card's
 * first review and end at the review stored in the card. Anything else — a card
 * graded before logging began, a grade whose log line was lost or has not synced
 * yet — would replay a different card, and the stored state is the better guess.
 */
export function memoryFromLog(
  log: readonly ReviewLogEntry[],
  card: Card,
  weights: readonly number[] | null,
): FSRSState | null {
  const first = log[0];
  const last = log[log.length - 1];
  if (!first || !last || first.s !== State.New) return null;
  if (last.t !== card.last_review?.getTime()) return null;
  const scheduler = fsrs(generatorParameters(weights ? { w: weights } : {}));
  let replayed = createEmptyCard(new Date(first.t));
  for (const entry of log) replayed = scheduler.next(replayed, new Date(entry.t), entry.r).card;
  return { stability: replayed.stability, difficulty: replayed.difficulty };
}
