/**
 * Turning the review log into the training items the FSRS optimizer reads.
 *
 * An item is one question FSRS should have been able to answer: given a card's
 * reviews so far, would it be recalled at the next one. The rules follow Anki's own
 * conversion of its review log for fsrs-rs: a card counts only when its history
 * starts at its first review, and only a review on a later day than the one before
 * it becomes an item, while same-day reviews stay inside the history as learning
 * steps.
 */

import { dateDiffInDays, State } from "ts-fsrs";
import type { ReviewLogEntry } from "../model/history";

/** One review as the optimizer sees it. */
export interface ItemReview {
  /** 1 again … 4 easy. */
  rating: number;
  /** Whole days since the previous review of the card, 0 for its first. */
  deltaT: number;
}

/** A card's reviews up to and including the one to be predicted. */
export interface TrainingItem {
  reviews: ItemReview[];
  /** A number standing for the card, the same for all its items. */
  card: number;
  /** When the last review was answered, in epoch milliseconds. */
  time: number;
}

/** Every training item in the log, oldest answer first. */
export function buildItems(entries: readonly ReviewLogEntry[]): TrainingItem[] {
  const byCard = new Map<string, ReviewLogEntry[]>();
  for (const entry of entries) {
    const list = byCard.get(entry.c);
    if (list) list.push(entry);
    else byCard.set(entry.c, [entry]);
  }

  const items: TrainingItem[] = [];
  // Sorted ids, so a card's number does not depend on the order the log arrived in.
  const ids = [...byCard.keys()].sort();
  ids.forEach((id, card) => {
    const reviews = [...(byCard.get(id) ?? [])].sort((a, b) => a.t - b.t);
    // Reviewed before logging began: the log holds the middle of its history, which
    // FSRS would read as the history of a new card.
    if (reviews[0]?.s !== State.New) return;
    const history: ItemReview[] = [];
    reviews.forEach((review, index) => {
      const previous = reviews[index - 1];
      // Days are counted the way the scheduler counts them, so the model is fitted
      // to the same intervals it will be asked about.
      const deltaT = previous ? dateDiffInDays(new Date(previous.t), new Date(review.t)) : 0;
      history.push({ rating: review.r, deltaT });
      if (index >= 1 && deltaT > 0) items.push({ reviews: [...history], card, time: review.t });
    });
  });
  return items.sort((a, b) => a.time - b.time);
}
