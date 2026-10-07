/**
 * Deciding whether weights fitted to the user's own reviews should replace the ones
 * in use.
 *
 * New weights are adopted only when they predict the user's reviews better than the
 * current ones, measured the way fsrs-rs measures a model: the recency-weighted log
 * loss of the predicted recall against what actually happened. The comparison is on
 * reviews the candidate never saw — it is fitted to the older part of the history
 * and judged on the newest part — because weights judged on their own training data
 * always look better than they are.
 */

import { default_w, forgetting_curve } from "ts-fsrs";
import type { ReviewLogEntry } from "../model/history";
import { sanitizeWeights } from "../model/srs";
import type { FsrsEngine } from "./engine";
import { buildItems, type TrainingItem } from "./items";

/**
 * Training items needed before a fit is attempted. Anki's own fitting code reads it
 * as the point below which the caller should not use the result; fsrs-rs itself
 * fits with far less, and the fit is not worth trusting there.
 */
export const MIN_ITEMS = 400;

/** The newest share of the items the candidate is judged on and not trained on. */
const HELD_OUT = 0.2;

/** What a fit found. */
export type FitOutcome =
  | { status: "not-enough"; items: number }
  | {
      status: "kept" | "adopted";
      items: number;
      /** Log loss of the weights in use on the held-out reviews. */
      lossBefore: number;
      /** Log loss of the candidate on the same reviews. */
      lossAfter: number;
      /** The new weights, when adopted. */
      weights: number[] | null;
    };

/**
 * The lowest initial stability the scheduler accepts. ts-fsrs raises any lower one to
 * this when it starts a card, while fsrs-rs fits and evaluates down to 0.001 days; a
 * first weight below it would make the fit describe a model the scheduler does not
 * run. Not exported by ts-fsrs, where it is a literal in `init_stability`.
 */
const SCHEDULER_MIN_INITIAL_STABILITY = 0.1;

/**
 * Fitted weights as the scheduler will use them: the four initial stabilities held
 * at the scheduler's floor, and every weight rounded short for `data.json` — the
 * fifth decimal changes no interval. Candidates are judged in this form, so what is
 * measured is what gets adopted.
 */
export function alignWithScheduler(weights: readonly number[]): number[] {
  return weights.map((w, i) => {
    const floored = i < 4 ? Math.max(w, SCHEDULER_MIN_INITIAL_STABILITY) : w;
    return Math.round(floored * 10000) / 10000;
  });
}

/** Predicted recall can reach neither 0 nor 1 under a logarithm. */
const EPSILON = 1e-7;

/**
 * Recency-weighted binary cross-entropy of `weights` on `items`, as fsrs-rs's own
 * evaluation computes it: later items weigh up to four times as much as early ones.
 */
export function logLoss(
  engine: FsrsEngine,
  weights: readonly number[],
  items: readonly TrainingItem[],
): number {
  const stabilities = engine.stabilities(weights, items);
  const last = Math.max(items.length - 1, 1);
  let loss = 0;
  let total = 0;
  items.forEach((item, index) => {
    const current = item.reviews[item.reviews.length - 1];
    const stability = stabilities[index];
    if (!current || stability === undefined) return;
    const recall = forgetting_curve([...weights], current.deltaT, stability);
    const p = Math.min(Math.max(recall, EPSILON), 1 - EPSILON);
    const y = current.rating > 1 ? 1 : 0;
    const weight = 0.25 + 0.75 * (index / last) ** 3;
    loss -= (y * Math.log(p) + (1 - y) * Math.log(1 - p)) * weight;
    total += weight;
  });
  return total > 0 ? loss / total : Number.NaN;
}

/**
 * Fit weights to the review log and decide whether they replace `current` (null for
 * the defaults). `minItems` is there for tests.
 */
export function fitWeights(
  engine: FsrsEngine,
  entries: readonly ReviewLogEntry[],
  current: readonly number[] | null,
  minItems = MIN_ITEMS,
): FitOutcome {
  const items = buildItems(entries);
  if (items.length < minItems) return { status: "not-enough", items: items.length };
  const inUse = current ?? default_w;

  const split = Math.floor(items.length * (1 - HELD_OUT));
  const past = items.slice(0, split);
  const recent = items.slice(split);
  const candidate = sanitizeWeights(alignWithScheduler(engine.train(past)));
  const lossBefore = logLoss(engine, inUse, recent);
  const lossAfter = candidate ? logLoss(engine, candidate, recent) : Number.NaN;
  const kept = {
    status: "kept",
    items: items.length,
    lossBefore,
    lossAfter,
    weights: null,
  } as const;
  // NaN compares false either way, so an unusable candidate is kept out too.
  if (!(lossAfter < lossBefore)) return kept;

  // The candidate earned the change; what is adopted is the same fit over every
  // review, the newest included. It has to beat the weights in use on the whole
  // history as well, which is Anki's own condition for taking a new fit.
  const full = sanitizeWeights(alignWithScheduler(engine.train(items)));
  if (!full || !(logLoss(engine, full, items) < logLoss(engine, inUse, items))) return kept;
  return { ...kept, status: "adopted", weights: full };
}
